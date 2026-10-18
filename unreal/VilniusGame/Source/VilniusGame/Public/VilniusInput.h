#pragma once

#include "CoreMinimal.h"
#include "InputActionValue.h"

class UInputAction;
class UInputMappingContext;
class APawn;
struct FKey;

/** Helpers that build Enhanced Input actions in code, so the greybox needs no input assets. */
namespace VilniusInput
{
	UInputAction* MakeAction(UObject* Outer, FName Name, EInputActionValueType Type);

	/** Maps Key to Action. bNegate flips the sign; bToYAxis routes a button to the Y axis of a 2D action. */
	void Map(UInputMappingContext* Context, UInputAction* Action, FKey Key, bool bNegate = false, bool bToYAxis = false);

	/** Makes Context the only active mapping for the pawn's local player. */
	void Activate(const APawn* Pawn, UInputMappingContext* Context);
}
