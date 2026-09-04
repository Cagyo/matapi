import { Inject, Injectable } from "@nestjs/common";

import {
  PRIVATE_SUBNET_DETECTOR,
  type PrivateSubnetDetectorPort,
  type PrivateSubnetSuggestion,
} from "../domain/ports/private-subnet-detector.port";

const MAX_SUGGESTIONS = 32;
const PAGE_SIZE = 8;

export interface PrivateSubnetSuggestionPage {
  readonly page: number;
  readonly pageCount: number;
  readonly truncated: boolean;
  readonly items: readonly PrivateSubnetSuggestion[];
}

@Injectable()
export class ListPrivateSubnetSuggestionsUseCase {
  constructor(
    @Inject(PRIVATE_SUBNET_DETECTOR)
    private readonly detector: PrivateSubnetDetectorPort,
  ) {}

  async execute(requestedPage = 1): Promise<PrivateSubnetSuggestionPage> {
    const detected = await this.detector.detect();
    const suggestions = detected.slice(0, MAX_SUGGESTIONS);
    const pageCount = Math.max(1, Math.ceil(suggestions.length / PAGE_SIZE));
    const page = clampPage(requestedPage, pageCount);
    const offset = (page - 1) * PAGE_SIZE;

    return {
      page,
      pageCount,
      truncated: detected.length >= MAX_SUGGESTIONS,
      items: suggestions.slice(offset, offset + PAGE_SIZE).map((suggestion, index) => ({
        selector: String(index),
        cidr: suggestion.cidr,
        interfaceLabels: [...suggestion.interfaceLabels],
        interfaceLabelCount: suggestion.interfaceLabelCount,
      })),
    };
  }
}

function clampPage(requestedPage: number, pageCount: number): number {
  if (!Number.isSafeInteger(requestedPage)) return 1;
  return Math.min(Math.max(requestedPage, 1), pageCount);
}
