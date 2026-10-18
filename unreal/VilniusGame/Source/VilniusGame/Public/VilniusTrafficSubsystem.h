#pragma once

#include "CoreMinimal.h"
#include "Subsystems/WorldSubsystem.h"
#include "VilniusTrafficSubsystem.generated.h"

class AStaticMeshActor;

/** One direction of travel along a road segment, as a world-space polyline. */
struct FVilniusLane
{
	TArray<FVector2D> Points; // centimetres, Unreal X/Y
	TArray<float> Distance;   // cumulative length at each point
	float SpeedCmS = 1389.f;
	TArray<int32> Next;       // indices into the lane array
	bool bSpawnable = false;

	float Length() const { return Distance.Num() ? Distance.Last() : 0.f; }
	FVector2D At(float S, FVector2D& OutDirection) const;
};

/**
 * Ambient traffic for the greybox: kinematic cars that follow the lane graph
 * exported by the pipeline, keep a headway and pick a legal turn at junctions.
 * No signals, overtaking or physics yet; see docs/game-foundation.md.
 */
UCLASS()
class VILNIUSGAME_API UVilniusTrafficSubsystem : public UTickableWorldSubsystem
{
	GENERATED_BODY()

public:
	virtual void OnWorldBeginPlay(UWorld& InWorld) override;
	virtual void Tick(float DeltaTime) override;
	virtual TStatId GetStatId() const override;
	virtual bool DoesSupportWorldType(const EWorldType::Type WorldType) const override;

	int32 NumLanes() const { return Lanes.Num(); }

private:
	struct FCar
	{
		TWeakObjectPtr<AStaticMeshActor> Actor;
		int32 Lane = INDEX_NONE;
		float S = 0.f;
		float Speed = 0.f;
		float Z = 0.f;
	};

	bool LoadTile(const FString& TileName, TMap<int64, int32>& LaneByKey);
	void Place(FCar& Car, bool bSnapHeight);
	void Respawn(FCar& Car);

	TArray<FVilniusLane> Lanes;
	TArray<int32> SpawnLanes;
	TArray<FCar> Cars;
};
