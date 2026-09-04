import type {
  PrivateSubnetDetectorPort,
  PrivateSubnetSuggestion,
} from "../domain/ports/private-subnet-detector.port";

type DetectedSubnet = Omit<PrivateSubnetSuggestion, "selector">;

export class InMemoryPrivateSubnetDetectorAdapter
  implements PrivateSubnetDetectorPort
{
  constructor(private readonly suggestions: readonly DetectedSubnet[] = []) {}

  async detect(): Promise<readonly DetectedSubnet[]> {
    return this.suggestions.map((suggestion) => ({
      cidr: suggestion.cidr,
      interfaceLabels: [...suggestion.interfaceLabels],
    }));
  }
}
