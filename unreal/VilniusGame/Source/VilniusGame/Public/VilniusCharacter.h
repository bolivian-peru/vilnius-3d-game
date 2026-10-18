#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Character.h"
#include "VilniusCharacter.generated.h"

class UCameraComponent;
class UInputAction;
class UInputMappingContext;
class USpringArmComponent;
class UStaticMeshComponent;
struct FInputActionValue;

/** On-foot player: third-person camera, walking, jumping and entering the nearest car. */
UCLASS()
class VILNIUSGAME_API AVilniusCharacter : public ACharacter
{
	GENERATED_BODY()

public:
	AVilniusCharacter();

	virtual void SetupPlayerInputComponent(UInputComponent* PlayerInputComponent) override;

	/** How close a car must be to enter it, centimetres. */
	UPROPERTY(EditAnywhere, Category = "Vilnius")
	float EnterVehicleRange = 450.f;

protected:
	UPROPERTY(VisibleAnywhere, Category = "Camera")
	TObjectPtr<USpringArmComponent> CameraBoom;

	UPROPERTY(VisibleAnywhere, Category = "Camera")
	TObjectPtr<UCameraComponent> Camera;

	/** Stand-in body until a skeletal mesh is assigned; hide it in a Blueprint child. */
	UPROPERTY(VisibleAnywhere, Category = "Vilnius")
	TObjectPtr<UStaticMeshComponent> Placeholder;

private:
	void Move(const FInputActionValue& Value);
	void Look(const FInputActionValue& Value);
	void Interact();

	UPROPERTY(Transient)
	TObjectPtr<UInputMappingContext> MappingContext;
	UPROPERTY(Transient)
	TObjectPtr<UInputAction> MoveAction;
	UPROPERTY(Transient)
	TObjectPtr<UInputAction> LookAction;
	UPROPERTY(Transient)
	TObjectPtr<UInputAction> JumpAction;
	UPROPERTY(Transient)
	TObjectPtr<UInputAction> InteractAction;
};
