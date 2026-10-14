/**
 * The page's picker from configuration: the decision model `PICKER` names (Clef Flash for
 * `clef`, Clef 27B for `clef-27b`, Jev for `jev`) through Workers AI and the AI Gateway in
 * `DECISION_GATEWAY` when the AI binding is there, otherwise the rules. Model failures fall
 * back to the rules per decision and are logged (never with request bodies).
 */
import { env } from 'cloudflare:workers';

import type { Picker } from '@gitstalk/shared-ask/pick/picker';
import { pickerFrom } from '@gitstalk/shared-ask/pick/picker-from-env';
import { log } from '../log';

export function pagePicker(): Picker {
  return pickerFrom({
    name: env.PICKER,
    ai: Reflect.get(env, 'AI'),
    gateway: env.DECISION_GATEWAY,
    onError: (decision, error) =>
      log.warn('decision model pick fell back to the rule', { decision, error }),
  });
}
