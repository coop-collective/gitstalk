/**
 * Picks the picker from configuration: the decision model `PICKER` names (`clef`, Clef Flash,
 * the configured default; `clef-27b`; `jev`) when the AI binding is there, otherwise the rules.
 */
import type { DecisionModelConfig } from './decision-model';
import { decisionModelFrom } from './decision-model';
import type { Picker } from './picker';
import { modelPicker, rulesPicker } from './picker';

/** `name` is the `PICKER` var (`clef`, `clef-27b`, `jev` or `rules`). */
export type PickerConfig = DecisionModelConfig;

export function pickerFrom(config: PickerConfig): Picker {
  const model = decisionModelFrom(config);
  return model === null ? rulesPicker : modelPicker(model);
}
