using UnrealBuildTool;

public class VilniusGame : ModuleRules
{
	public VilniusGame(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new string[]
		{
			"Core", "CoreUObject", "Engine", "InputCore", "EnhancedInput", "DeveloperSettings"
		});

		PrivateDependencyModuleNames.AddRange(new string[] { "Json", "PhysicsCore" });
	}
}
