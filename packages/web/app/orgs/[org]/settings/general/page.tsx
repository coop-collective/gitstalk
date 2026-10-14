import { OrgGeneralSettings } from '../../../../../components/orgs/org-forms';
import { OrgMark } from '../../../../../components/orgs/org-mark';
import { OrgSettingsFrame } from '../../../../../components/orgs/org-settings-frame';
import { PictureSection } from '../../../../../components/settings/picture-section';
import { pictureNote } from '../../../../../src/account/picture-notes';
import { queryValue } from '../../../../../src/server/account-page';
import type { OrgParams } from '../../../../../src/server/org-settings';
import { orgSettings, orgSettingsMetadata } from '../../../../../src/server/org-settings';

/** Per person and per request: never prerendered or cached. */
export const dynamic = 'force-dynamic';
export const generateMetadata = orgSettingsMetadata('General');

/**
 * Org Settings → General (owners and admins): name and description in one form, the icon as
 * a multipart upload to `../icon` that comes back here with `?picture=`.
 */
export default async function OrgGeneralSettingsPage(props: {
  readonly params: OrgParams;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const settings = await orgSettings(props.params, 'general');
  const { org, session, path } = settings;
  const note = pictureNote(queryValue(await props.searchParams, 'picture'));
  return (
    <OrgSettingsFrame
      settings={settings}
      current="general"
      title="General"
      lede="How the organization is named and pictured on its page, its repositories and menus."
    >
      <OrgGeneralSettings org={org} access={{ csrf: session.csrfToken, path }} />
      <PictureSection
        id="icon"
        title="Icon"
        lede="PNG, JPEG, WebP or GIF up to 2 MB, cropped square after you choose it. Without one, the handle's first letters."
        shape="icon"
        action={`/orgs/${encodeURIComponent(org.handle)}/settings/icon`}
        csrf={session.csrfToken}
        hasPicture={org.iconKey !== null}
        note={note}
        removeLabel="Remove icon (use the letters)"
        current={<OrgMark handle={org.handle} iconKey={org.iconKey} size={96} />}
      />
    </OrgSettingsFrame>
  );
}
