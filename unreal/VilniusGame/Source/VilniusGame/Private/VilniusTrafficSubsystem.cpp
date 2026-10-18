#include "VilniusTrafficSubsystem.h"

#include "Components/StaticMeshComponent.h"
#include "Dom/JsonObject.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/World.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "VilniusSettings.h"

DEFINE_LOG_CATEGORY_STATIC(LogVilniusTraffic, Log, All);

namespace
{
	const float CarLength = 440.f;
	const float MinGap = 350.f;

	int64 LaneKey(int32 Segment, int32 Direction)
	{
		return (static_cast<int64>(Segment) << 1) | (Direction > 0 ? 1 : 0);
	}
}

FVector2D FVilniusLane::At(float S, FVector2D& OutDirection) const
{
	int32 i = 1;
	while (i < Distance.Num() - 1 && Distance[i] < S)
	{
		++i;
	}
	const float Span = FMath::Max(Distance[i] - Distance[i - 1], 1.f);
	const float T = FMath::Clamp((S - Distance[i - 1]) / Span, 0.f, 1.f);
	OutDirection = (Points[i] - Points[i - 1]).GetSafeNormal();
	return FMath::Lerp(Points[i - 1], Points[i], T);
}

bool UVilniusTrafficSubsystem::DoesSupportWorldType(const EWorldType::Type WorldType) const
{
	return WorldType == EWorldType::Game || WorldType == EWorldType::PIE;
}

TStatId UVilniusTrafficSubsystem::GetStatId() const
{
	RETURN_QUICK_DECLARE_CYCLE_STAT(UVilniusTrafficSubsystem, STATGROUP_Tickables);
}

bool UVilniusTrafficSubsystem::LoadTile(const FString& TileName, TMap<int64, int32>& LaneByKey)
{
	const FString Path = FPaths::ProjectContentDir() / TEXT("VilniusData") / TileName / TEXT("tile.json");
	FString Text;
	TSharedPtr<FJsonObject> Root;
	if (!FFileHelper::LoadFileToString(Text, *Path) ||
		!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Root) || !Root.IsValid())
	{
		UE_LOG(LogVilniusTraffic, Warning, TEXT("Could not read %s"), *Path);
		return false;
	}
	const TSharedPtr<FJsonObject>* Graph = nullptr;
	if (!Root->TryGetObjectField(TEXT("lanegraph"), Graph))
	{
		return false;
	}

	for (const TSharedPtr<FJsonValue>& Value : (*Graph)->GetArrayField(TEXT("segments")))
	{
		const TSharedPtr<FJsonObject> Segment = Value->AsObject();
		const int32 Id = Segment->GetIntegerField(TEXT("id"));
		if (LaneByKey.Contains(LaneKey(Id, 1)))
		{
			continue; // already loaded from a neighbouring tile's buffer
		}

		TArray<FVector2D> Centre;
		for (const TSharedPtr<FJsonValue>& PointValue : Segment->GetArrayField(TEXT("points")))
		{
			const TArray<TSharedPtr<FJsonValue>>& P = PointValue->AsArray();
			Centre.Add(FVector2D(P[0]->AsNumber(), P[1]->AsNumber())); // metres, x east, y north
		}
		if (Centre.Num() < 2)
		{
			continue;
		}

		const FString Class = Segment->GetStringField(TEXT("class"));
		const bool bOpen = Segment->GetStringField(TEXT("car_access")) == TEXT("yes");
		const bool bThrough = Class != TEXT("service") && Class != TEXT("pedestrian") && Class != TEXT("living_street");
		const float LaneWidth = Segment->GetNumberField(TEXT("lane_width_m"));
		const float Speed = Segment->GetNumberField(TEXT("maxspeed_kmh")) / 3.6f * 100.f;
		const bool bOneWay = Segment->GetBoolField(TEXT("oneway"));
		const int32 Backward = Segment->GetIntegerField(TEXT("lanes_bwd"));

		for (int32 Direction : {1, -1})
		{
			if (Direction < 0 && Backward == 0)
			{
				continue;
			}
			// Two-way: drive the lane beside the centre line. One-way: follow the carriageway centre.
			const float Offset = bOneWay ? 0.f : LaneWidth * 0.5f;

			FVilniusLane Lane;
			Lane.SpeedCmS = Speed;
			Lane.bSpawnable = bOpen && bThrough;
			const int32 Count = Centre.Num();
			for (int32 k = 0; k < Count; ++k)
			{
				const int32 i = Direction > 0 ? k : Count - 1 - k;
				const int32 Prev = FMath::Clamp(i - Direction, 0, Count - 1);
				const int32 Nxt = FMath::Clamp(i + Direction, 0, Count - 1);
				const FVector2D Dir = (Centre[Nxt] - Centre[Prev]).GetSafeNormal();
				// Right of travel in a y-north frame is (dy, -dx). Unreal's Y points south.
				const FVector2D Metres = Centre[i] + FVector2D(Dir.Y, -Dir.X) * Offset;
				Lane.Points.Add(FVector2D(100.0 * Metres.X, -100.0 * Metres.Y));
				Lane.Distance.Add(k == 0 ? 0.f : Lane.Distance.Last() + FVector2D::Distance(Lane.Points[k], Lane.Points[k - 1]));
			}
			LaneByKey.Add(LaneKey(Id, Direction), Lanes.Add(MoveTemp(Lane)));
		}
	}

	for (const TSharedPtr<FJsonValue>& Value : (*Graph)->GetArrayField(TEXT("connections")))
	{
		const TArray<TSharedPtr<FJsonValue>>& C = Value->AsArray();
		const int32* From = LaneByKey.Find(LaneKey(static_cast<int32>(C[0]->AsNumber()), static_cast<int32>(C[1]->AsNumber())));
		const int32* To = LaneByKey.Find(LaneKey(static_cast<int32>(C[2]->AsNumber()), static_cast<int32>(C[3]->AsNumber())));
		if (From && To)
		{
			Lanes[*From].Next.AddUnique(*To);
		}
	}
	return true;
}

void UVilniusTrafficSubsystem::OnWorldBeginPlay(UWorld& InWorld)
{
	Super::OnWorldBeginPlay(InWorld);

	const UVilniusSettings* Settings = GetDefault<UVilniusSettings>();
	TMap<int64, int32> LaneByKey;
	for (const FString& Tile : Settings->Tiles)
	{
		LoadTile(Tile, LaneByKey);
	}
	for (int32 i = 0; i < Lanes.Num(); ++i)
	{
		if (Lanes[i].bSpawnable && Lanes[i].Length() > 2.f * CarLength)
		{
			SpawnLanes.Add(i);
		}
	}
	UE_LOG(LogVilniusTraffic, Log, TEXT("Traffic graph: %d lanes, %d spawnable"), Lanes.Num(), SpawnLanes.Num());
	if (SpawnLanes.IsEmpty())
	{
		return;
	}

	UStaticMesh* Cube = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"));
	for (int32 i = 0; i < Settings->TrafficCars; ++i)
	{
		AStaticMeshActor* Actor = InWorld.SpawnActor<AStaticMeshActor>();
		if (!Actor)
		{
			continue;
		}
		Actor->SetMobility(EComponentMobility::Movable);
		Actor->GetStaticMeshComponent()->SetStaticMesh(Cube);
		Actor->SetActorScale3D(FVector(CarLength / 100.f, 1.8f, 1.3f));
		Actor->GetStaticMeshComponent()->SetCollisionProfileName(TEXT("BlockAllDynamic"));

		FCar& Car = Cars.AddDefaulted_GetRef();
		Car.Actor = Actor;
		Respawn(Car);
	}
}

void UVilniusTrafficSubsystem::Respawn(FCar& Car)
{
	Car.Lane = SpawnLanes[FMath::RandRange(0, SpawnLanes.Num() - 1)];
	Car.S = FMath::FRandRange(0.f, Lanes[Car.Lane].Length());
	Car.Speed = 0.f;
	Place(Car, true);
}

void UVilniusTrafficSubsystem::Place(FCar& Car, bool bSnapHeight)
{
	AStaticMeshActor* Actor = Car.Actor.Get();
	if (!Actor)
	{
		return;
	}
	FVector2D Direction;
	const FVector2D XY = Lanes[Car.Lane].At(Car.S, Direction);

	// Follow the collision surface. A snap searches the whole height range; otherwise stay near
	// the current level so a car under a bridge does not jump onto the deck.
	const float Top = bSnapHeight ? 30000.f : Car.Z + 250.f;
	const float Bottom = bSnapHeight ? -10000.f : Car.Z - 400.f;
	FCollisionQueryParams Params(SCENE_QUERY_STAT(VilniusTraffic), false, Actor);
	FHitResult Hit;
	if (GetWorld()->LineTraceSingleByObjectType(Hit, FVector(XY, Top), FVector(XY, Bottom),
		FCollisionObjectQueryParams(ECC_WorldStatic), Params))
	{
		Car.Z = Hit.ImpactPoint.Z;
	}
	Actor->SetActorLocationAndRotation(FVector(XY, Car.Z + 65.f),
		FRotator(0.f, FMath::RadiansToDegrees(FMath::Atan2(Direction.Y, Direction.X)), 0.f));
}

void UVilniusTrafficSubsystem::Tick(float DeltaTime)
{
	Super::Tick(DeltaTime);

	for (FCar& Car : Cars)
	{
		if (!Car.Actor.IsValid())
		{
			continue;
		}
		const FVilniusLane& Lane = Lanes[Car.Lane];

		// Headway: distance to the closest car ahead in the same lane.
		float Gap = TNumericLimits<float>::Max();
		for (const FCar& Other : Cars)
		{
			if (&Other != &Car && Other.Lane == Car.Lane && Other.S > Car.S)
			{
				Gap = FMath::Min(Gap, Other.S - Car.S - CarLength);
			}
		}
		const float Target = Gap < MinGap ? 0.f : FMath::Min(Lane.SpeedCmS, (Gap - MinGap) * 1.2f);
		Car.Speed = FMath::FInterpConstantTo(Car.Speed, Target, DeltaTime, Target < Car.Speed ? 900.f : 250.f);
		Car.S += Car.Speed * DeltaTime;

		if (Car.S >= Lane.Length())
		{
			if (Lane.Next.IsEmpty())
			{
				Respawn(Car);
				continue;
			}
			Car.S -= Lane.Length();
			Car.Lane = Lane.Next[FMath::RandRange(0, Lane.Next.Num() - 1)];
		}
		Place(Car, false);
	}
}
