import { InlineKeyboard } from 'grammy';
import type { LocaleCatalog } from '../../locales';

export type ExternalWorkflow =
  | 'logs'
  | 'csv'
  | 'settings'
  | 'config'
  | 'configImport'
  | 'drive'
  | 'systemUpdate'
  | 'camera';
export type ExternalWorkflowPhase =
  | 'cancelPending'
  | 'leaveRunning'
  | 'alreadyTerminal';

export interface ReturnHomeCallbackInput {
  workflow: ExternalWorkflow;
  phase: ExternalWorkflowPhase;
}

const workflowCode: Readonly<Record<ExternalWorkflow, string>> = {
  logs: 'l',
  csv: 'c',
  settings: 's',
  config: 'f',
  configImport: 'i',
  drive: 'd',
  systemUpdate: 'u',
  camera: 'a',
};

const workflowByCode: Readonly<Record<string, ExternalWorkflow | undefined>> = {
  l: 'logs',
  c: 'csv',
  s: 'settings',
  f: 'config',
  i: 'configImport',
  d: 'drive',
  u: 'systemUpdate',
  a: 'camera',
};

const phaseCode: Readonly<Record<ExternalWorkflowPhase, string>> = {
  cancelPending: 'c',
  leaveRunning: 'r',
  alreadyTerminal: 't',
};

const phaseByCode: Readonly<Record<string, ExternalWorkflowPhase | undefined>> = {
  c: 'cancelPending',
  r: 'leaveRunning',
  t: 'alreadyTerminal',
};

export function returnHomeCallback(input: ReturnHomeCallbackInput): string {
  return ['rh', workflowCode[input.workflow], phaseCode[input.phase]].join(':');
}

export function parseReturnHomeCallback(
  data: string,
): ReturnHomeCallbackInput | null {
  const match = /^rh:([lcsfidua]):([crt])(?![\s\S])/.exec(data);
  if (!match) return null;

  const workflow = workflowByCode[match[1]];
  const phase = phaseByCode[match[2]];
  if (!workflow || !phase) return null;

  return { workflow, phase };
}

export function isReturnHomeCallback(data: string | undefined): boolean {
  return parseReturnHomeCallback(data ?? '') !== null;
}

export function returnHomeKeyboard(
  catalog: LocaleCatalog,
  input: ReturnHomeCallbackInput,
): InlineKeyboard {
  return new InlineKeyboard().text(
    catalog.home.common.home,
    returnHomeCallback(input),
  );
}

export function appendReturnHomeButton(
  keyboard: InlineKeyboard,
  catalog: LocaleCatalog,
  input: ReturnHomeCallbackInput,
): InlineKeyboard {
  return keyboard
    .row()
    .text(catalog.home.common.home, returnHomeCallback(input));
}
