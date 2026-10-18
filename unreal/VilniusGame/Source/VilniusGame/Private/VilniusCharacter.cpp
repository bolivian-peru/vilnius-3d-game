#include "VilniusCharacter.h"

#include "Camera/CameraComponent.h"
#include "Components/CapsuleComponent.h"
#include "Components/StaticMeshComponent.h"
#include "EngineUtils.h"
#include "EnhancedInputComponent.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "GameFramework/SpringArmComponent.h"
#include "InputAction.h"
#include "InputMappingContext.h"
#include "UObject/ConstructorHelpers.h"
#include "VilniusCar.h"
#include "VilniusInput.h"

AVilniusCharacter::AVilniusCharacter()
{
	GetCapsuleComponent()->InitCapsuleSize(38.f, 90.f);

	bUseControllerRotationYaw = false;
	GetCharacterMovement()->bOrientRotationToMovement = true;
	GetCharacterMovement()->RotationRate = FRotator(0.f, 540.f, 0.f);
	GetCharacterMovement()->MaxWalkSpeed = 450.f;
	GetCharacterMovement()->JumpZVelocity = 480.f;
	GetCharacterMovement()->AirControl = 0.25f;
	GetCharacterMovement()->SetWalkableFloorAngle(50.f);

	CameraBoom = CreateDefaultSubobject<USpringArmComponent>(TEXT("CameraBoom"));
	CameraBoom->SetupAttachment(RootComponent);
	CameraBoom->TargetArmLength = 380.f;
	CameraBoom->SocketOffset = FVector(0.f, 45.f, 60.f);
	CameraBoom->bUsePawnControlRotation = true;

	Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
	Camera->SetupAttachment(CameraBoom, USpringArmComponent::SocketName);

	Placeholder = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Placeholder"));
	Placeholder->SetupAttachment(RootComponent);
	Placeholder->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Placeholder->SetRelativeScale3D(FVector(0.55f, 0.35f, 1.75f));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cylinder(TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
	if (Cylinder.Succeeded())
	{
		Placeholder->SetStaticMesh(Cylinder.Object);
	}
}

void AVilniusCharacter::SetupPlayerInputComponent(UInputComponent* PlayerInputComponent)
{
	Super::SetupPlayerInputComponent(PlayerInputComponent);

	if (!MappingContext)
	{
		MoveAction = VilniusInput::MakeAction(this, TEXT("IA_Move"), EInputActionValueType::Axis2D);
		LookAction = VilniusInput::MakeAction(this, TEXT("IA_Look"), EInputActionValueType::Axis2D);
		JumpAction = VilniusInput::MakeAction(this, TEXT("IA_Jump"), EInputActionValueType::Boolean);
		InteractAction = VilniusInput::MakeAction(this, TEXT("IA_Interact"), EInputActionValueType::Boolean);

		MappingContext = NewObject<UInputMappingContext>(this, TEXT("IMC_OnFoot"));
		VilniusInput::Map(MappingContext, MoveAction, EKeys::W, false, true);
		VilniusInput::Map(MappingContext, MoveAction, EKeys::S, true, true);
		VilniusInput::Map(MappingContext, MoveAction, EKeys::D);
		VilniusInput::Map(MappingContext, MoveAction, EKeys::A, true);
		VilniusInput::Map(MappingContext, MoveAction, EKeys::Gamepad_Left2D);
		VilniusInput::Map(MappingContext, LookAction, EKeys::Mouse2D);
		VilniusInput::Map(MappingContext, LookAction, EKeys::Gamepad_Right2D);
		VilniusInput::Map(MappingContext, JumpAction, EKeys::SpaceBar);
		VilniusInput::Map(MappingContext, JumpAction, EKeys::Gamepad_FaceButton_Bottom);
		VilniusInput::Map(MappingContext, InteractAction, EKeys::F);
		VilniusInput::Map(MappingContext, InteractAction, EKeys::Gamepad_FaceButton_Top);
	}
	VilniusInput::Activate(this, MappingContext);

	if (UEnhancedInputComponent* Input = Cast<UEnhancedInputComponent>(PlayerInputComponent))
	{
		Input->BindAction(MoveAction, ETriggerEvent::Triggered, this, &AVilniusCharacter::Move);
		Input->BindAction(LookAction, ETriggerEvent::Triggered, this, &AVilniusCharacter::Look);
		Input->BindAction(JumpAction, ETriggerEvent::Started, this, &ACharacter::Jump);
		Input->BindAction(JumpAction, ETriggerEvent::Completed, this, &ACharacter::StopJumping);
		Input->BindAction(InteractAction, ETriggerEvent::Started, this, &AVilniusCharacter::Interact);
	}
}

void AVilniusCharacter::Move(const FInputActionValue& Value)
{
	const FVector2D Axis = Value.Get<FVector2D>();
	const FRotator Yaw(0.f, GetControlRotation().Yaw, 0.f);
	AddMovementInput(FRotationMatrix(Yaw).GetUnitAxis(EAxis::X), Axis.Y);
	AddMovementInput(FRotationMatrix(Yaw).GetUnitAxis(EAxis::Y), Axis.X);
}

void AVilniusCharacter::Look(const FInputActionValue& Value)
{
	const FVector2D Axis = Value.Get<FVector2D>();
	AddControllerYawInput(Axis.X);
	AddControllerPitchInput(-Axis.Y);
}

void AVilniusCharacter::Interact()
{
	AVilniusCar* Nearest = nullptr;
	float BestDistSq = FMath::Square(EnterVehicleRange);
	for (TActorIterator<AVilniusCar> It(GetWorld()); It; ++It)
	{
		const float DistSq = FVector::DistSquared(It->GetActorLocation(), GetActorLocation());
		if (DistSq < BestDistSq && !It->HasDriver())
		{
			BestDistSq = DistSq;
			Nearest = *It;
		}
	}
	if (Nearest)
	{
		Nearest->Enter(this);
	}
}
