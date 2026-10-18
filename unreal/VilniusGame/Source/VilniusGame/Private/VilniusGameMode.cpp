#include "VilniusGameMode.h"

#include "Engine/World.h"
#include "GameFramework/Pawn.h"
#include "VilniusCar.h"
#include "VilniusCharacter.h"

AVilniusGameMode::AVilniusGameMode()
{
	DefaultPawnClass = AVilniusCharacter::StaticClass();
	StartingCarClass = AVilniusCar::StaticClass();
}

void AVilniusGameMode::RestartPlayer(AController* NewPlayer)
{
	Super::RestartPlayer(NewPlayer);

	const APawn* Pawn = NewPlayer ? NewPlayer->GetPawn() : nullptr;
	if (!Pawn || !StartingCarClass)
	{
		return;
	}
	const FVector Location = Pawn->GetActorLocation() + Pawn->GetActorRightVector() * 350.f + FVector(0.f, 0.f, 60.f);
	FActorSpawnParameters Params;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AdjustIfPossibleButAlwaysSpawn;
	GetWorld()->SpawnActor<AVilniusCar>(StartingCarClass, Location, Pawn->GetActorRotation(), Params);
}
