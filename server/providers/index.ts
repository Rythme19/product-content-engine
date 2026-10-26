// Provider registry. Add a provider by implementing Provider (types.ts) and listing it here.
import { higgsfield } from "./higgsfield.ts";
import { mock } from "./mock.ts";
import type { Provider, ModelInfo } from "./types.ts";

export * from "./types.ts";

const PROVIDERS: Provider[] = [higgsfield, mock];

export const activeProviders = () => PROVIDERS.filter((p) => p.configured());
export const providerById = (id: string) => PROVIDERS.find((p) => p.id === id && p.configured());

export function findModel(id: string): { provider: Provider; model: ModelInfo } | undefined {
  for (const provider of activeProviders()) {
    const model = provider.models.find((m) => m.id === id);
    if (model) return { provider, model };
  }
}

/** Client-safe catalog (no functions). */
export const catalog = () =>
  activeProviders().flatMap((p) => p.models.map(({ body, ...m }) => ({ ...m, provider_label: p.label })));
