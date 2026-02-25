import { ArchetypeId, LayerId } from "../contracts";

export const ARCHETYPE_LAYER_COMPATIBILITY: Record<ArchetypeId, LayerId[]> = {
  hook: ["renderer"],
  service: ["services", "main"],
  ui: ["renderer"],
  transport: ["main", "tauri", "services"],
  store: ["services", "renderer"],
};

export function isArchetypeLayerCompatible(layer: LayerId, archetype: ArchetypeId): boolean {
  const allowedLayers = ARCHETYPE_LAYER_COMPATIBILITY[archetype];
  if (!allowedLayers) {
    throw new Error(`ownership-compatibility: unknown archetype ${archetype}`);
  }
  return allowedLayers.includes(layer);
}

export function assertArchetypeLayerCompatibility(layer: LayerId, archetype: ArchetypeId, symbolKey: string): void {
  const allowedLayers = ARCHETYPE_LAYER_COMPATIBILITY[archetype];
  if (!allowedLayers) {
    throw new Error(`ownership-compatibility: unknown archetype ${archetype}`);
  }
  if (!allowedLayers.includes(layer)) {
    throw new Error(
      `ownership-compatibility: gate blocked ${symbolKey} (archetype=${archetype}, layer=${layer}, allowed=${allowedLayers.join(",")})`,
    );
  }
}
