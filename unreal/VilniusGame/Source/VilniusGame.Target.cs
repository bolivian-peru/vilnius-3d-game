using UnrealBuildTool;

public class VilniusGameTarget : TargetRules
{
	public VilniusGameTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("VilniusGame");
	}
}
