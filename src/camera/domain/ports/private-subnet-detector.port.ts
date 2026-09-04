export const PRIVATE_SUBNET_DETECTOR = Symbol("PRIVATE_SUBNET_DETECTOR");

export interface PrivateSubnetSuggestion {
  readonly selector: string;
  readonly cidr: string;
  readonly interfaceLabels: readonly string[];
  readonly interfaceLabelCount: number;
}

export interface PrivateSubnetDetectorPort {
  detect(): Promise<
    readonly Omit<PrivateSubnetSuggestion, "selector">[]
  >;
}
