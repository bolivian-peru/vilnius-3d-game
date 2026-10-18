using UnrealBuildTool;

public class VilniusGameEditorTarget : TargetRules
{
	public VilniusGameEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("VilniusGame");
	}
}
