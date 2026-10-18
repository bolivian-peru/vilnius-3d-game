#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "VilniusGeo.generated.h"

/**
 * Conversions between LKS-94 metres and Unreal world centimetres.
 * Unreal axes are east, south, up: X = 100*(E-E0), Y = -100*(N-N0), Z = 100*(H-H0).
 */
UCLASS()
class VILNIUSGAME_API UVilniusGeo : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	/** Project-local metres (x east, y north, z up) to Unreal world centimetres. */
	UFUNCTION(BlueprintPure, Category = "Vilnius|Geo")
	static FVector LocalMetresToWorld(const FVector& LocalMetres);

	UFUNCTION(BlueprintPure, Category = "Vilnius|Geo")
	static FVector WorldToLocalMetres(const FVector& World);

	UFUNCTION(BlueprintPure, Category = "Vilnius|Geo")
	static FVector Lks94ToWorld(double Easting, double Northing, double Height);

	/** Returns (Easting, Northing, Height) in metres. */
	UFUNCTION(BlueprintPure, Category = "Vilnius|Geo")
	static FVector WorldToLks94(const FVector& World);
};
