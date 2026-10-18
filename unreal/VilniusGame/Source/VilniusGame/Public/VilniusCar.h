#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Pawn.h"
#include "VilniusCar.generated.h"

class AVilniusCharacter;
class UCameraComponent;
class UInputAction;
class UInputMappingContext;
class USpringArmComponent;
class UStaticMeshComponent;
struct FInputActionValue;

/**
 * Greybox car: a rigid box on four ray-cast wheels. It needs no rigged vehicle
 * asset, which keeps the first drive independent of art. Replace with a Chaos
 * Vehicles pawn once a car mesh exists; Enter/Exit is the only contract the
 * character relies on.
 */
UCLASS()
class VILNIUSGAME_API AVilniusCar : public APawn
{
	GENERATED_BODY()

public:
	AVilniusCar();

	virtual void Tick(float DeltaSeconds) override;
	virtual void SetupPlayerInputComponent(UInputComponent* PlayerInputComponent) override;

	void Enter(AVilniusCharacter* Character);
	bool HasDriver() const { return Driver != nullptr; }

	UFUNCTION(BlueprintPure, Category = "Vilnius|Car")
	float GetSpeedKmh() const;

	UPROPERTY(EditAnywhere, Category = "Handling")
	float MassKg = 1550.f;

	/** Half wheelbase and half track, centimetres. */
	UPROPERTY(EditAnywhere, Category = "Handling")
	FVector2D WheelOffset = FVector2D(135.f, 78.f);

	UPROPERTY(EditAnywhere, Category = "Handling")
	float WheelRadius = 33.f;

	/** Suspension travel at rest, centimetres. */
	UPROPERTY(EditAnywhere, Category = "Handling")
	float SuspensionRest = 24.f;

	/** Spring rate per wheel, N/m. */
	UPROPERTY(EditAnywhere, Category = "Handling")
	float SpringRate = 38000.f;

	/** Damper rate per wheel, N*s/m. */
	UPROPERTY(EditAnywhere, Category = "Handling")
	float DamperRate = 3800.f;

	UPROPERTY(EditAnywhere, Category = "Handling")
	float EngineForce = 7500.f;

	UPROPERTY(EditAnywhere, Category = "Handling")
	float BrakeForce = 14000.f;

	UPROPERTY(EditAnywhere, Category = "Handling")
	float TopSpeedKmh = 170.f;

	UPROPERTY(EditAnywhere, Category = "Handling")
	float MaxSteerDegrees = 32.f;

	/** Tyre friction coefficient; the rear value drops while the handbrake is held. */
	UPROPERTY(EditAnywhere, Category = "Handling")
	float TyreGrip = 1.05f;

	/** Lateral stiffness: sideways force per m/s of slip, as a fraction of wheel load. */
	UPROPERTY(EditAnywhere, Category = "Handling")
	float CorneringStiffness = 0.9f;

protected:
	UPROPERTY(VisibleAnywhere, Category = "Car")
	TObjectPtr<UStaticMeshComponent> Body;

	UPROPERTY(VisibleAnywhere, Category = "Car")
	TObjectPtr<UStaticMeshComponent> Cabin;

	UPROPERTY(VisibleAnywhere, Category = "Car")
	TObjectPtr<UStaticMeshComponent> Wheels[4];

	UPROPERTY(VisibleAnywhere, Category = "Camera")
	TObjectPtr<USpringArmComponent> CameraBoom;

	UPROPERTY(VisibleAnywhere, Category = "Camera")
	TObjectPtr<UCameraComponent> Camera;

private:
	void OnThrottle(const FInputActionValue& Value);
	void OnSteer(const FInputActionValue& Value);
	void OnLook(const FInputActionValue& Value);
	void OnHandbrake(const FInputActionValue& Value);
	void Exit();

	UPROPERTY(Transient)
	TObjectPtr<AVilniusCharacter> Driver;

	UPROPERTY(Transient)
	TObjectPtr<UInputMappingContext> MappingContext;
	UPROPERTY(Transient)
	TObjectPtr<UInputAction> ThrottleAction;
	UPROPERTY(Transient)
	TObjectPtr<UInputAction> SteerAction;
	UPROPERTY(Transient)
	TObjectPtr<UInputAction> LookAction;
	UPROPERTY(Transient)
	TObjectPtr<UInputAction> HandbrakeAction;
	UPROPERTY(Transient)
	TObjectPtr<UInputAction> ExitAction;

	float Throttle = 0.f;
	float Steer = 0.f;
	float SteerSmoothed = 0.f;
	bool bHandbrake = false;
};
