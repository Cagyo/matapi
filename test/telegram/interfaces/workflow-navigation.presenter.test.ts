import { InlineKeyboard } from 'grammy';
import { describe, expect, it } from 'vitest';
import type { WorkflowReturnReceipt } from '../../../src/telegram/domain/workflow-return';
import { WorkflowNavigationPresenter } from '../../../src/telegram/interfaces/workflow-navigation.presenter';

const receipt = { id: 'abcdefghijklmnop' } as WorkflowReturnReceipt;

function buttons(keyboard: InlineKeyboard) {
  return keyboard.inline_keyboard.flat().map((button) => ({ text: button.text, data: 'callback_data' in button ? button.callback_data : undefined }));
}

describe('WorkflowNavigationPresenter', () => {
  const presenter = new WorkflowNavigationPresenter();

  it('appends destination-aware origin and Home exits on their own row', () => {
    const keyboard = new InlineKeyboard().text('Keep working', 'work:next');
    presenter.appendExitRow(keyboard, receipt, { origin: 'Back to History', home: 'Home' });

    expect(buttons(keyboard)).toEqual([
      { text: 'Keep working', data: 'work:next' },
      { text: 'Back to History', data: 'wr:abcdefghijklmnop:o' },
      { text: 'Home', data: 'wr:abcdefghijklmnop:h' },
    ]);
    expect(keyboard.inline_keyboard.at(-1)).toHaveLength(2);
  });

  it('names cancellable work and keeps origin distinct from Home', () => {
    expect(buttons(presenter.cancelKeyboard(receipt, { cancel: 'Cancel sensor setup', home: 'Home' }))).toEqual([
      { text: 'Cancel sensor setup', data: 'wr:abcdefghijklmnop:o' },
      { text: 'Home', data: 'wr:abcdefghijklmnop:h' },
    ]);
  });

  it('states that running work continues while preserving both destinations', () => {
    expect(buttons(presenter.runningKeyboard(receipt, { origin: 'History · export continues', home: 'Home · export continues' }))).toEqual([
      { text: 'History · export continues', data: 'wr:abcdefghijklmnop:o' },
      { text: 'Home · export continues', data: 'wr:abcdefghijklmnop:h' },
    ]);
  });

  it('renders retry return as an exact receipt-bound destination', () => {
    expect(buttons(presenter.retryReturnKeyboard(receipt, { label: 'Retry return', destination: 'origin' }))).toEqual([
      { text: 'Retry return', data: 'wr:abcdefghijklmnop:o' },
    ]);
  });
});
