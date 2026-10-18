#pragma once

#include "CoreMinimal.h"
#include "Engine/DeveloperSettings.h"
#include "VilniusSettings.generated.h"

/** Project-wide geographic contract. Must match pipeline/vilnius_pipeline/config.py. */
UCLASS(Config = Game, DefaultConfig, meta = (DisplayName = "Vilnius"))
class VILNIUSGAME_API UVilniusSettings : public UDeveloperSettings
{
	GENERATED_BODY()

public:
	/** LKS-94 (EPSG:3346) easting of the world origin, metres. */
	UPROPERTY(Config, EditAnywhere, Category = "Georeference")
	double OriginEasting = 582250.0;

	/** LKS-94 (EPSG:3346) northing of the world origin, metres. */
	UPROPERTY(Config, EditAnywhere, Category = "Georeference")
	double OriginNorthing = 6062250.0;

	/** Source height that maps to Z = 0, metres. */
	UPROPERTY(Config, EditAnywhere, Category = "Georeference")
	double OriginHeight = 100.0;

	/** Tiles whose Content/VilniusData/<tile>/tile.json is loaded for traffic. */
	UPROPERTY(Config, EditAnywhere, Category = "World")
	TArray<FString> Tiles;

	UPROPERTY(Config, EditAnywhere, Category = "Traffic", meta = (ClampMin = 0))
	int32 TrafficCars = 40;
};
