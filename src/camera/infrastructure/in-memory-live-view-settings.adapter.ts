import {
  createLiveViewSettingsDocument,
  type LiveViewSettingsDocument,
} from "../domain/live-view-settings";
import type { LiveViewSettingsStorePort } from "../domain/ports/live-view-settings-store.port";

const INITIAL_SETTINGS: LiveViewSettingsDocument = {
  version: 1,
  generation: 0,
  enabled: false,
  allowedCameraCidrs: [],
};

export class InMemoryLiveViewSettingsAdapter implements LiveViewSettingsStorePort {
  #committed: LiveViewSettingsDocument;
  #bootGeneration: number;

  constructor(initial: LiveViewSettingsDocument = INITIAL_SETTINGS) {
    this.#committed = createLiveViewSettingsDocument(initial);
    this.#bootGeneration = this.#committed.generation;
  }

  async readCommitted(): Promise<LiveViewSettingsDocument> {
    return createLiveViewSettingsDocument(this.#committed);
  }

  bootLoadedGeneration(): number {
    return this.#bootGeneration;
  }

  setCommitted(settings: LiveViewSettingsDocument): void {
    this.#committed = createLiveViewSettingsDocument(settings);
  }

  async simulateDevelopmentRestart(): Promise<void> {
    this.#bootGeneration = this.#committed.generation;
  }
}
