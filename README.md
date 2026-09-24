# Medication box checks

Shared stock and expiry tracker for up to 40 medication boxes. Staff open the link and use it straight away, with no accounts or logins. Data is stored in Netlify Blobs, so every phone sees the same live list.

## Deploy (no terminal needed)

Netlify's drag and drop upload cannot run the data functions, so deploy through GitHub:

1. Create a free GitHub account, then a new repository (private is fine).
2. On the repository page, click "uploading an existing file". Drag in everything from this unzipped folder, keeping the `public` and `netlify` folders as they are, and commit.
3. In Netlify choose Add new site, then Import an existing project, then GitHub, and pick the repository.
4. Leave the build settings as they are and click Deploy.

## Trial with one box

Open Settings, set Number of boxes to 1 and save. Raise it later; nothing needs rebuilding.

## Optional setup PIN

Without a PIN, anyone with the link can use Master stock and Settings. To protect them:

1. In Netlify go to Site configuration, then Environment variables.
2. Add `ADMIN_PIN` with a number of your choice, then redeploy (Deploys, Trigger deploy).

Checking boxes and signing stock in and out never needs the PIN.

## Keeping it private

Anyone with the link can open the page. Rename the site in Netlify to something hard to guess and share the link only with staff.
