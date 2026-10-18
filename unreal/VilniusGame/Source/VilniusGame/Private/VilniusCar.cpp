#include "VilniusCar.h"

#include "Camera/CameraComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/World.h"
#include "EnhancedInputComponent.h"
#include "GameFramework/PlayerController.h"
#include "GameFramework/SpringArmComponent.h"
#include "InputAction.h"
#include "InputMappingContext.h"
#include "UObject/ConstructorHelpers.h"
#include "VilniusCharacter.h"
#include "VilniusInput.h"

namespace
{
	// Unreal forces are kg*cm/s^2, so one newton is 100 of them.
	constexpr float NewtonToUnreal = 100.f;
}

AVilniusCar::AVilniusCar()
{
	PrimaryActorTick.bCanEverTick = true;
	PrimaryActorTick.TickGroup = TG_PrePhysics;

	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cube(TEXT("/Engine/BasicShapes/Cube.Cube"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cylinder(TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));

	Body = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Body"));
	RootComponent = Body;
	Body->SetRelativeScale3D(FVector(4.4f, 1.8f, 0.55f));
	Body->SetSimulatePhysics(true);
	Body->SetCollisionProfileName(TEXT("Vehicle"));
	Body->SetLinearDamping(0.02f);
	Body->SetAngularDamping(0.6f);
	Body->BodyInstance.bUseCCD = true;
	if (Cube.Succeeded())
	{
		Body->SetStaticMesh(Cube.Object);
	}

	Cabin = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Cabin"));
	Cabin->SetupAttachment(Body);
	Cabin->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	// Relative transforms are in the scaled body's space.
	Cabin->SetRelativeLocation(FVector(-5.f, 0.f, 90.f));
	Cabin->SetRelativeScale3D(FVector(0.5f, 0.9f, 0.9f));
	if (Cube.Succeeded())
	{
		Cabin->SetStaticMesh(Cube.Object);
	}

	for (int32 i = 0; i < 4; ++i)
	{
		Wheels[i] = CreateDefaultSubobject<UStaticMeshComponent>(*FString::Printf(TEXT("Wheel%d"), i));
		Wheels[i]->SetupAttachment(Body);
		Wheels[i]->SetUsingAbsoluteScale(true);
		Wheels[i]->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		Wheels[i]->SetWorldScale3D(FVector(0.66f, 0.66f, 0.22f));
		if (Cylinder.Succeeded())
		{
			Wheels[i]->SetStaticMesh(Cylinder.Object);
		}
	}

	CameraBoom = CreateDefaultSubobject<USpringArmComponent>(TEXT("CameraBoom"));
	CameraBoom->SetupAttachment(Body);
	CameraBoom->SetUsingAbsoluteScale(true);
	CameraBoom->TargetArmLength = 750.f;
	CameraBoom->SetRelativeRotation(FRotator(-12.f, 0.f, 0.f));
	CameraBoom->SetRelativeLocation(FVector(0.f, 0.f, 200.f));
	CameraBoom->bUsePawnControlRotation = true;
	CameraBoom->bEnableCameraLag = true;
	CameraBoom->CameraLagSpeed = 6.f;
	CameraBoom->bDoCollisionTest = false;

	Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
	Camera->SetupAttachment(CameraBoom, USpringArmComponent::SocketName);
}

float AVilniusCar::GetSpeedKmh() const
{
	return Body->GetPhysicsLinearVelocity().Size() * 0.036f;
}

void AVilniusCar::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);

	if (!FMath::IsNearlyEqual(Body->GetMass(), MassKg, 1.f))
	{
		Body->SetMassOverrideInKg(NAME_None, MassKg, true);
		Body->SetCenterOfMass(FVector(0.f, 0.f, -25.f));
	}

	const FTransform Xf = Body->GetComponentTransform();
	const FVector Up = Xf.GetUnitAxis(EAxis::Z);
	const FVector Forward = Xf.GetUnitAxis(EAxis::X);
	const FVector Right = Xf.GetUnitAxis(EAxis::Y);
	const float ForwardSpeed = FVector::DotProduct(Body->GetPhysicsLinearVelocity(), Forward) / 100.f; // m/s

	// Less steering lock at speed keeps the car controllable on a keyboard.
	const float SpeedFactor = FMath::GetMappedRangeValueClamped(FVector2D(5.f, 40.f), FVector2D(1.f, 0.3f), FMath::Abs(ForwardSpeed));
	SteerSmoothed = FMath::FInterpTo(SteerSmoothed, Steer * SpeedFactor, DeltaSeconds, 6.f);
	const float SteerAngle = SteerSmoothed * MaxSteerDegrees;

	FCollisionQueryParams Params(SCENE_QUERY_STAT(VilniusWheel), false, this);
	if (Driver)
	{
		Params.AddIgnoredActor(Driver);
	}

	const float TraceLength = SuspensionRest + WheelRadius;
	const float BodyHalfHeight = 0.5f * 100.f * Body->GetRelativeScale3D().Z;

	for (int32 i = 0; i < 4; ++i)
	{
		const bool bFront = i < 2;
		const float SideSign = (i % 2 == 0) ? -1.f : 1.f;
		// Wheel mount in world space, on the underside of the body.
		const FVector Mount = Xf.GetLocation() + Forward * (bFront ? WheelOffset.X : -WheelOffset.X)
			+ Right * SideSign * WheelOffset.Y - Up * (BodyHalfHeight - 10.f);

		const FQuat WheelYaw = bFront ? FQuat(Up, FMath::DegreesToRadians(SteerAngle)) : FQuat::Identity;
		const FVector WheelForward = WheelYaw.RotateVector(Forward);
		const FVector WheelRight = WheelYaw.RotateVector(Right);

		FHitResult Hit;
		const bool bGrounded = GetWorld()->LineTraceSingleByChannel(Hit, Mount, Mount - Up * TraceLength, ECC_WorldStatic, Params);
		const float Extension = bGrounded ? Hit.Distance - WheelRadius : SuspensionRest;

		Wheels[i]->SetWorldLocationAndRotation(Mount - Up * FMath::Max(Extension, 0.f),
			FRotationMatrix::MakeFromZX(WheelRight, WheelForward).ToQuat());

		if (!bGrounded)
		{
			continue;
		}

		const FVector PointVelocity = Body->GetPhysicsLinearVelocityAtPoint(Hit.ImpactPoint) / 100.f; // m/s

		// Suspension: spring on compression, damper on closing speed. Never pulls the car down.
		const float Compression = (SuspensionRest - Extension) / 100.f;
		const float Load = FMath::Max(0.f, SpringRate * Compression - DamperRate * FVector::DotProduct(PointVelocity, Up));
		Body->AddForceAtLocation(Hit.ImpactNormal * Load * NewtonToUnreal, Mount);

		// Tyre forces live in the contact plane and share one friction budget.
		const FVector PlaneForward = FVector::VectorPlaneProject(WheelForward, Hit.ImpactNormal).GetSafeNormal();
		const FVector PlaneRight = FVector::VectorPlaneProject(WheelRight, Hit.ImpactNormal).GetSafeNormal();
		const float LongSpeed = FVector::DotProduct(PointVelocity, PlaneForward);
		const float LatSpeed = FVector::DotProduct(PointVelocity, PlaneRight);

		const bool bLocked = bHandbrake && !bFront;
		const float Grip = TyreGrip * (bLocked ? 0.55f : 1.f);
		float Lateral = -LatSpeed * CorneringStiffness * Load;

		float Longitudinal = 0.f;
		if (bLocked)
		{
			Longitudinal = -FMath::Sign(LongSpeed) * FMath::Min(BrakeForce * 0.5f, FMath::Abs(LongSpeed) * MassKg);
		}
		else if (Throttle != 0.f)
		{
			const bool bBraking = FMath::Abs(ForwardSpeed) > 1.f && FMath::Sign(Throttle) != FMath::Sign(ForwardSpeed);
			if (bBraking)
			{
				// Brake bias to the front.
				Longitudinal = -FMath::Sign(LongSpeed) * BrakeForce * (bFront ? 0.32f : 0.18f) * FMath::Abs(Throttle);
			}
			else if (!bFront)
			{
				const float Limit = (Throttle > 0.f ? TopSpeedKmh : 35.f) / 3.6f;
				const float Fade = FMath::Clamp(1.f - FMath::Abs(ForwardSpeed) / Limit, 0.f, 1.f);
				Longitudinal = Throttle * EngineForce * 0.5f * FMath::Sqrt(Fade);
			}
		}
		else
		{
			// Rolling resistance and engine braking bring a coasting car to rest.
			Longitudinal = -LongSpeed * 60.f;
		}

		const float Budget = Grip * Load;
		const float Demand = FMath::Sqrt(Lateral * Lateral + Longitudinal * Longitudinal);
		if (Demand > Budget && Demand > KINDA_SMALL_NUMBER)
		{
			Lateral *= Budget / Demand;
			Longitudinal *= Budget / Demand;
		}

		// Applying tyre forces a little above the road limits body roll in this simple model.
		const FVector ApplyAt = Hit.ImpactPoint + Up * (WheelRadius + 12.f);
		Body->AddForceAtLocation((PlaneForward * Longitudinal + PlaneRight * Lateral) * NewtonToUnreal, ApplyAt);
	}

	// Aerodynamic drag.
	const FVector Velocity = Body->GetPhysicsLinearVelocity() / 100.f;
	Body->AddForce(-Velocity * Velocity.Size() * 0.42f * NewtonToUnreal);
}

void AVilniusCar::SetupPlayerInputComponent(UInputComponent* PlayerInputComponent)
{
	Super::SetupPlayerInputComponent(PlayerInputComponent);

	if (!MappingContext)
	{
		ThrottleAction = VilniusInput::MakeAction(this, TEXT("IA_Throttle"), EInputActionValueType::Axis1D);
		SteerAction = VilniusInput::MakeAction(this, TEXT("IA_Steer"), EInputActionValueType::Axis1D);
		LookAction = VilniusInput::MakeAction(this, TEXT("IA_CarLook"), EInputActionValueType::Axis2D);
		HandbrakeAction = VilniusInput::MakeAction(this, TEXT("IA_Handbrake"), EInputActionValueType::Boolean);
		ExitAction = VilniusInput::MakeAction(this, TEXT("IA_Exit"), EInputActionValueType::Boolean);

		MappingContext = NewObject<UInputMappingContext>(this, TEXT("IMC_Driving"));
		VilniusInput::Map(MappingContext, ThrottleAction, EKeys::W);
		VilniusInput::Map(MappingContext, ThrottleAction, EKeys::S, true);
		VilniusInput::Map(MappingContext, ThrottleAction, EKeys::Gamepad_RightTriggerAxis);
		VilniusInput::Map(MappingContext, ThrottleAction, EKeys::Gamepad_LeftTriggerAxis, true);
		VilniusInput::Map(MappingContext, SteerAction, EKeys::D);
		VilniusInput::Map(MappingContext, SteerAction, EKeys::A, true);
		VilniusInput::Map(MappingContext, SteerAction, EKeys::Gamepad_LeftX);
		VilniusInput::Map(MappingContext, LookAction, EKeys::Mouse2D);
		VilniusInput::Map(MappingContext, LookAction, EKeys::Gamepad_Right2D);
		VilniusInput::Map(MappingContext, HandbrakeAction, EKeys::SpaceBar);
		VilniusInput::Map(MappingContext, HandbrakeAction, EKeys::Gamepad_FaceButton_Bottom);
		VilniusInput::Map(MappingContext, ExitAction, EKeys::F);
		VilniusInput::Map(MappingContext, ExitAction, EKeys::Gamepad_FaceButton_Top);
	}
	VilniusInput::Activate(this, MappingContext);

	if (UEnhancedInputComponent* Input = Cast<UEnhancedInputComponent>(PlayerInputComponent))
	{
		Input->BindAction(ThrottleAction, ETriggerEvent::Triggered, this, &AVilniusCar::OnThrottle);
		Input->BindAction(ThrottleAction, ETriggerEvent::Completed, this, &AVilniusCar::OnThrottle);
		Input->BindAction(SteerAction, ETriggerEvent::Triggered, this, &AVilniusCar::OnSteer);
		Input->BindAction(SteerAction, ETriggerEvent::Completed, this, &AVilniusCar::OnSteer);
		Input->BindAction(LookAction, ETriggerEvent::Triggered, this, &AVilniusCar::OnLook);
		Input->BindAction(HandbrakeAction, ETriggerEvent::Triggered, this, &AVilniusCar::OnHandbrake);
		Input->BindAction(HandbrakeAction, ETriggerEvent::Completed, this, &AVilniusCar::OnHandbrake);
		Input->BindAction(ExitAction, ETriggerEvent::Started, this, &AVilniusCar::Exit);
	}
}

void AVilniusCar::OnThrottle(const FInputActionValue& Value)
{
	Throttle = FMath::Clamp(Value.Get<float>(), -1.f, 1.f);
}

void AVilniusCar::OnSteer(const FInputActionValue& Value)
{
	Steer = FMath::Clamp(Value.Get<float>(), -1.f, 1.f);
}

void AVilniusCar::OnLook(const FInputActionValue& Value)
{
	const FVector2D Axis = Value.Get<FVector2D>();
	AddControllerYawInput(Axis.X);
	AddControllerPitchInput(-Axis.Y);
}

void AVilniusCar::OnHandbrake(const FInputActionValue& Value)
{
	bHandbrake = Value.Get<bool>();
}

void AVilniusCar::Enter(AVilniusCharacter* Character)
{
	APlayerController* PC = Character ? Cast<APlayerController>(Character->GetController()) : nullptr;
	if (!PC || Driver)
	{
		return;
	}
	Driver = Character;
	Character->SetActorEnableCollision(false);
	Character->SetActorHiddenInGame(true);
	Character->AttachToComponent(Body, FAttachmentTransformRules::KeepWorldTransform);
	PC->Possess(this);
	PC->SetControlRotation(GetActorRotation());
}

void AVilniusCar::Exit()
{
	APlayerController* PC = Cast<APlayerController>(GetController());
	if (!PC || !Driver || GetSpeedKmh() > 15.f)
	{
		return;
	}

	// Step out on the driver's side (left), falling back to the right if it is blocked.
	const FVector Right = GetActorRightVector();
	FVector ExitLocation = GetActorLocation() - Right * 230.f + FVector(0.f, 0.f, 120.f);
	FCollisionQueryParams Params(SCENE_QUERY_STAT(VilniusExit), false, this);
	Params.AddIgnoredActor(Driver);
	if (GetWorld()->OverlapBlockingTestByChannel(ExitLocation, FQuat::Identity, ECC_Pawn,
		FCollisionShape::MakeCapsule(38.f, 90.f), Params))
	{
		ExitLocation = GetActorLocation() + Right * 230.f + FVector(0.f, 0.f, 120.f);
	}

	AVilniusCharacter* Character = Driver;
	Driver = nullptr;
	Throttle = Steer = 0.f;
	bHandbrake = true;

	Character->DetachFromActor(FDetachmentTransformRules::KeepWorldTransform);
	Character->SetActorLocationAndRotation(ExitLocation, FRotator(0.f, GetActorRotation().Yaw, 0.f));
	Character->SetActorHiddenInGame(false);
	Character->SetActorEnableCollision(true);
	PC->Possess(Character);
}
