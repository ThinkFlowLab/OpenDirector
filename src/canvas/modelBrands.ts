import sources from "./modelBrands.json" with { type: "json" };

/** Display metadata only; model routing and capability checks never use brands. */
export function modelBrand(modelId: string, explicitOrganization?: string) {
  const name = modelId.trim();
  const organization = (
    explicitOrganization ?? (name.includes("/") ? name.split("/")[0]! : "")
  ).toLowerCase();
  const exact = sources.logos.find(
    (brand) => brand.org.toLowerCase() === organization,
  );
  if (exact) return exact;
  const aliases: [RegExp, string][] = [
    [/^(minimax|fasth3|fastvideo-fasth3)/i, "MiniMaxAI"],
    [/^kling(?:-|$)/i, "KlingAI"],
    [/^(deepseek)/i, "deepseek-ai"],
    [/^(qwen|qwq)/i, "Qwen"],
    [/^(kimi)/i, "moonshotai"],
    [/^(glm|glyph)/i, "zai-org"],
    [/^(gpt-|o[134](?:-|$))/i, "openai"],
    [/^(gemma|gemini|translategemma)/i, "google"],
    [/^(llama)/i, "meta-llama"],
    [/^(phi-)/i, "microsoft"],
    [/^(mistral|ministral|mixtral)/i, "mistralai"],
    [/^(hunyuan)/i, "tencent"],
    [/^(wan\d|wan-)/i, "Wan-AI"],
    [/^(seedance|seedream|seed-oss)/i, "ByteDance-Seed"],
    [/^(moss-)/i, "OpenMOSS-Team"],
    [/^(ltx-)/i, "Lightricks"],
    [/^(flux)/i, "black-forest-labs"],
    [/^(stable-diffusion|stable-audio)/i, "stabilityai"],
  ];
  const bare = name.split("/").at(-1)!;
  const org = aliases.find(([pattern]) => pattern.test(bare))?.[1];
  return sources.logos.find(
    (brand) => brand.org.toLowerCase() === org?.toLowerCase(),
  );
}
