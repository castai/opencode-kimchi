import { KimchiModel, ModelTier } from "./model-registry.js";

interface ApiAlternative {
  slug: string;
  display_name: string;
}

interface ApiModelEntry {
  slug: string;
  display_name: string;
  description?: string;
  provider?: string;
  tool_call?: boolean;
  reasoning?: boolean;
  supports_images?: boolean;
  input_modalities?: string[];
  output_modalities?: string[];
  is_serverless?: boolean;
  is_routable?: boolean;
  limits: {
    context_window: number;
    max_output_tokens: number;
  };
  pricing?: {
    input_per_1m: number;
    output_per_1m: number;
  };
  deprecated_at?: string;
  sunset_at?: string;
  replacement_model?: string;
  alternatives?: ApiAlternative[];
  deprecation_note?: string;
}

interface ApiResponse {
  models: ApiModelEntry[];
}

/**
 * Fetch models from the Kimchi API endpoint
 */
export async function fetchModelsFromApi(
  options: {
    baseUrl?: string;
    apiKey: string;
    timeoutMs?: number;
  }
): Promise<{ models: KimchiModel[]; errors: string[] }> {
  const baseUrl = options.baseUrl || "https://llm.kimchi.dev";
  const url = `${baseUrl}/v1/models/metadata?include_in_cli=true`;
  const errors: string[] = [];

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs ?? 10000);

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      errors.push(`API request failed with status ${response.status}`);
      return { models: [], errors };
    }

    const responseData = await response.json();
    const data: ApiResponse = responseData as ApiResponse;
    
    // Transform API models to KimchiModel format
    const kimchiModels: KimchiModel[] = data.models.map((apiModel) => {
      // Determine tier based on capabilities (will be refined by MODEL_PLACEMENTS)
      const inferredTier = inferTierFromCapabilities(apiModel);
      
      const deprecatedAt = apiModel.deprecated_at ? new Date(apiModel.deprecated_at) : undefined;
      const sunsetAt = apiModel.sunset_at ? new Date(apiModel.sunset_at) : undefined;

      return {
        id: apiModel.slug,
        name: apiModel.display_name || apiModel.slug,
        provider: apiModel.provider || "kimchi",
        tier: inferredTier,
        contextWindow: apiModel.limits.context_window,
        maxOutput: apiModel.limits.max_output_tokens,
        supportsReasoning: apiModel.reasoning ?? false,
        supportsImages: 
          apiModel.supports_images ?? 
          (apiModel.input_modalities?.includes("image") ?? false),
        cost: {
          input: apiModel.pricing?.input_per_1m ?? 1.0,
          output: apiModel.pricing?.output_per_1m ?? 3.0,
        },
        deprecatedAt: deprecatedAt && !isNaN(deprecatedAt.getTime()) ? deprecatedAt : undefined,
        sunsetAt: sunsetAt && !isNaN(sunsetAt.getTime()) ? sunsetAt : undefined,
        replacementModel: apiModel.replacement_model,
        alternatives: apiModel.alternatives?.map((a) => ({ id: a.slug, name: a.display_name })),
        deprecationNote: apiModel.deprecation_note,
      };
    });

    return { models: kimchiModels, errors };
  } catch (error: unknown) {
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        errors.push("API request timed out");
      } else if (error instanceof TypeError && error.message.includes("Failed to fetch")) {
        errors.push("Network error while fetching models from API");
      } else {
        errors.push(`Unexpected error fetching models: ${error.message}`);
      }
    } else {
      errors.push(`Unexpected error fetching models: ${String(error)}`);
    }
    return { models: [], errors };
  }
}

/**
 * Infer tier from model capabilities when API doesn't provide explicit tier hints
 */
function inferTierFromCapabilities(model: ApiModelEntry): ModelTier {
  // Reasoning models get priority for reasoning tasks
  if (model.reasoning) {
    return "reasoning";
  }
  
  // Cost-based tiering for non-reasoning models
  const inputCost = model.pricing?.input_per_1m ?? 1.0;
  const outputCost = model.pricing?.output_per_1m ?? 3.0;
  const blendedCost = inputCost + outputCost;
  
  if (blendedCost <= 2.0) {
    return "quick";
  }
  
  return "coding";
}