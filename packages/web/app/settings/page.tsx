import { AccountSettings } from '../../components/account/account-settings';
import { AvatarForm, ProfileForm } from '../../components/account/account-forms';
import { Avatar } from '../../components/account/avatar';
import { SettingsSection } from '../../components/settings/settings-shell';
import { pictureNote } from '../../src/account/picture-notes';
import { accountPage, queryValue } from '../../src/server/account-page';

export const metadata = { title: 'Public profile' };
/** Per person and per request: never prerendered or cached. */
export const dynamic = 'force-dynamic';

type PageProps = {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
};

/** Settings → Public profile: the picture, name, bio and website people see on your page. */
export default async function ProfileSettingsPage({ searchParams }: PageProps) {
  const { session, profile } = await accountPage('/settings');
  const note = pictureNote(queryValue(await searchParams, 'picture'));
  const name = profile.displayName === '' ? profile.handle : profile.displayName;
  return (
    <AccountSettings
      current="profile"
      profile={profile}
      title="Public profile"
      lede={
        <>
          What anyone sees on <a href={`/${profile.handle}`}>your page</a> and beside your work.
        </>
      }
    >
      <SettingsSection
        id="picture"
        title="Picture"
        lede="Shown next to your handle on repositories, beans and decisions. Without one you get a generated picture with your initials."
      >
        <AvatarForm
          csrf={session.csrfToken}
          current={<Avatar seed={profile.id} label={name} imageKey={profile.avatarKey} size={96} />}
          hasPicture={profile.avatarKey !== null}
          note={note}
        />
      </SettingsSection>
      <SettingsSection id="profile" title="Profile">
        <ProfileForm
          csrf={session.csrfToken}
          profile={{ displayName: profile.displayName, bio: profile.bio, website: profile.website }}
        />
      </SettingsSection>
    </AccountSettings>
  );
}
