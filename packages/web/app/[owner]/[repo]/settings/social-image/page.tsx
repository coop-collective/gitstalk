import { imageUrl } from '@gitstalk/shared-media/images';

import { RepositorySettingsFrame } from '../../../../../components/repository/repository-settings-frame';
import styles from '../../../../../components/repository/repository.module.css';
import { PictureSection } from '../../../../../components/settings/picture-section';
import { pictureNote } from '../../../../../src/account/picture-notes';
import { queryValue } from '../../../../../src/server/account-page';
import type { RepositoryParams } from '../../../../../src/server/repository-page';
import type { SettingsQuery } from '../../../../../src/server/repository-settings';
import {
  repositorySettings,
  settingsMetadata,
} from '../../../../../src/server/repository-settings';

/** Per person and per request: never prerendered or cached. */
export const dynamic = 'force-dynamic';
export const generateMetadata = settingsMetadata('Social image');

/**
 * Settings → Social image (the owner): the picture link previews show. Uploads are
 * multipart POSTs to `./upload` (cropped in the browser first when scripts run), which
 * redirects back here with `?picture=`.
 */
export default async function SocialImageSettingsPage(props: {
  readonly params: RepositoryParams;
  readonly searchParams: SettingsQuery;
}) {
  const settings = await repositorySettings(props.params, 'social-image');
  const { record, base, session } = settings;
  const note = pictureNote(queryValue(await props.searchParams, 'picture'));
  return (
    <RepositorySettingsFrame settings={settings} current="social-image" title="Social image">
      <PictureSection
        id="social"
        title="Preview picture"
        lede="Shown when a link to this repository is shared. PNG, JPEG, WebP or GIF up to 2 MB, cropped to 2:1 (1280 × 640) after you choose it."
        shape="social"
        action={`${base}/settings/social-image/upload`}
        csrf={session.csrfToken}
        hasPicture={record.social_image_key !== null}
        note={note}
        removeLabel="Remove social image"
        current={
          record.social_image_key === null ? (
            <div className={styles.socialEmpty}>
              No social image: previews show the name and description.
            </div>
          ) : (
            <img
              className={styles.socialPreview}
              src={imageUrl(record.social_image_key, 640)}
              alt="The current social image"
              width={420}
              height={210}
            />
          )
        }
      />
    </RepositorySettingsFrame>
  );
}
