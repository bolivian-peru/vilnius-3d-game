#include "VilniusInput.h"

#include "EnhancedInputSubsystems.h"
#include "Engine/LocalPlayer.h"
#include "GameFramework/Pawn.h"
#include "GameFramework/PlayerController.h"
#include "InputAction.h"
#include "InputMappingContext.h"
#include "InputModifiers.h"

UInputAction* VilniusInput::MakeAction(UObject* Outer, FName Name, EInputActionValueType Type)
{
	UInputAction* Action = NewObject<UInputAction>(Outer, Name);
	Action->ValueType = Type;
	return Action;
}

void VilniusInput::Map(UInputMappingContext* Context, UInputAction* Action, FKey Key, bool bNegate, bool bToYAxis)
{
	FEnhancedActionKeyMapping& Mapping = Context->MapKey(Action, Key);
	if (bToYAxis)
	{
		UInputModifierSwizzleAxis* Swizzle = NewObject<UInputModifierSwizzleAxis>(Context);
		Swizzle->Order = EInputAxisSwizzle::YXZ;
		Mapping.Modifiers.Add(Swizzle);
	}
	if (bNegate)
	{
		Mapping.Modifiers.Add(NewObject<UInputModifierNegate>(Context));
	}
}

void VilniusInput::Activate(const APawn* Pawn, UInputMappingContext* Context)
{
	const APlayerController* PC = Pawn ? Cast<APlayerController>(Pawn->GetController()) : nullptr;
	if (!PC || !PC->GetLocalPlayer())
	{
		return;
	}
	if (UEnhancedInputLocalPlayerSubsystem* Subsystem =
		ULocalPlayer::GetSubsystem<UEnhancedInputLocalPlayerSubsystem>(PC->GetLocalPlayer()))
	{
		Subsystem->ClearAllMappings();
		Subsystem->AddMappingContext(Context, 0);
	}
}
