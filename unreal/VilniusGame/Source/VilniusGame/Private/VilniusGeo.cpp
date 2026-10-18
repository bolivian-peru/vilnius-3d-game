#include "VilniusGeo.h"

#include "VilniusSettings.h"

FVector UVilniusGeo::LocalMetresToWorld(const FVector& LocalMetres)
{
	return FVector(100.0 * LocalMetres.X, -100.0 * LocalMetres.Y, 100.0 * LocalMetres.Z);
}

FVector UVilniusGeo::WorldToLocalMetres(const FVector& World)
{
	return FVector(World.X / 100.0, -World.Y / 100.0, World.Z / 100.0);
}

FVector UVilniusGeo::Lks94ToWorld(double Easting, double Northing, double Height)
{
	const UVilniusSettings* Settings = GetDefault<UVilniusSettings>();
	return LocalMetresToWorld(FVector(Easting - Settings->OriginEasting, Northing - Settings->OriginNorthing,
		Height - Settings->OriginHeight));
}

FVector UVilniusGeo::WorldToLks94(const FVector& World)
{
	const UVilniusSettings* Settings = GetDefault<UVilniusSettings>();
	const FVector Local = WorldToLocalMetres(World);
	return FVector(Local.X + Settings->OriginEasting, Local.Y + Settings->OriginNorthing, Local.Z + Settings->OriginHeight);
}
