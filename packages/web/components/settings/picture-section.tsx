/**
 * A settings section for one uploaded picture (an org's icon, a repository's social image):
 * the current one with its upload control (`PictureUpload`: crop dialog with scripts, the
 * plain multipart form without) and a remove button. The route handler at `action` validates,
 * stores in R2 and redirects back with `?picture=`.
 */
import type { ReactNode } from 'react';

import type { PictureNote } from '../../src/account/picture-notes';
import type { PictureShape } from '../../src/settings/picture-crop';
import repo from '../repository/repository.module.css';
import { PictureUpload } from './picture-upload';
import { SettingsSection } from './settings-shell';

export function PictureSection(props: {
  readonly id: string;
  readonly title: string;
  readonly lede: string;
  readonly shape: Exclude<PictureShape, 'avatar'>;
  /** The route handler that takes `file` (upload) or `remove=1`. */
  readonly action: string;
  readonly csrf: string;
  readonly current: ReactNode;
  readonly hasPicture: boolean;
  readonly note: PictureNote | null;
  readonly removeLabel: string;
}) {
  return (
    <SettingsSection id={props.id} title={props.title} lede={props.lede}>
      <PictureUpload
        shape={props.shape}
        noun={props.shape === 'icon' ? 'icon' : 'image'}
        cropTitle={props.shape === 'icon' ? 'Crop the icon' : 'Crop the social image'}
        action={props.action}
        csrf={props.csrf}
        current={props.current}
        hasPicture={props.hasPicture}
        note={props.note}
        buttonClassName={repo.secondary}
        remove={
          props.hasPicture ? (
            <form method="post" action={props.action}>
              <input type="hidden" name="csrf" value={props.csrf} />
              <input type="hidden" name="remove" value="1" />
              <button type="submit" className={repo.danger}>
                {props.removeLabel}
              </button>
            </form>
          ) : null
        }
      />
    </SettingsSection>
  );
}
