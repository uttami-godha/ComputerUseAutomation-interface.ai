import type { Artifact } from "./artifact/schema.ts";
import { ArtifactStore } from "./artifact/store.ts";

export type CapabilitySummary = {
  capabilityId: string;
  name: string;
  target: {
    surfaceKind: Artifact["target"]["surfaceKind"];
    appId: string;
    vendorProduct?: string;
    tenantId?: string;
  };
  params: Artifact["params"];
  outputs: Artifact["outputs"];
};

export class CapabilityCatalog {
  constructor(
    private store: ArtifactStore,
  ) {}

  list(): CapabilitySummary[] {
    return this.store.list().map((artifact) =>
      this.summarize(artifact),
    );
  }

  get(
    capabilityId: string,
    tenantId?: string,
  ): CapabilitySummary | undefined {
    const artifact =
      this.store.load(
        capabilityId,
        tenantId,
      );

    if (!artifact) return undefined;

    return this.summarize(artifact);
  }

  load(
    capabilityId: string,
    tenantId?: string,
  ): Artifact | undefined {
    return this.store.load(
      capabilityId,
      tenantId,
    );
  }

  private summarize(
    artifact: Artifact,
  ): CapabilitySummary {
    return {
      capabilityId:
        artifact.capabilityId,
      name: artifact.name,
      target: {
        surfaceKind:
          artifact.target.surfaceKind,
        appId: artifact.target.appId,
        vendorProduct:
          artifact.target.vendorProduct,
        tenantId:
          artifact.target.tenantId,
      },
      params: artifact.params,
      outputs: artifact.outputs,
    };
  }
}