#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "VilniusGameMode.generated.h"

class AVilniusCar;

UCLASS()
class VILNIUSGAME_API AVilniusGameMode : public AGameModeBase
{
	GENERATED_BODY()

public:
	AVilniusGameMode();

	virtual void RestartPlayer(AController* NewPlayer) override;

	/** Car parked next to the player at the start of a session. */
	UPROPERTY(EditAnywhere, Category = "Vilnius")
	TSubclassOf<AVilniusCar> StartingCarClass;
};
