# Shared review: setup for your IT admin

> **Parked (November 2026).** Live shared review was removed from the app. Teams review by merging
> reviewers' copies (Comment › Merge reviews). The server code and these notes are kept in case it's
> wanted later; the app-side sign-in and review panel are in git history (commit d0a40a1).

HDF Studio itself needs no login. It opens, edits and saves PDFs on your own computer, works offline,
and sends nothing anywhere. Sign-in only comes into play for **shared review**, where a team comments
on the same PDF together and sees each other's comments appear live.

Shared review needs one small server that everyone can reach (an office machine, a VM, or a cloud
host), and, to limit it to staff, a one-time Microsoft 365 app registration. After that, people sign in
with their normal **@hiveng.ca** Microsoft account. Anyone else is refused, both in the app and by the
server.

## How sign-in works

- When someone starts or joins a review, HDF Studio opens their web browser at Microsoft's own sign-in
  page. Passwords, MFA and passkeys are handled by Microsoft, never by HDF Studio.
- Microsoft returns an ID token. HDF Studio checks that the account ends in @hiveng.ca, then keeps the
  person signed in (Microsoft's refresh token, stored for that Windows user) so they aren't asked again.
- Each request to the review server carries the token. The server checks Microsoft's signature, that
  the token was issued by your tenant for this app, that it hasn't expired, and that the email is
  @hiveng.ca. Comments are signed with the account name, and nobody can edit or delete someone
  else's comment.
- Your Conditional Access policies (MFA, compliant device, location) apply as usual, because the sign-in
  goes through Microsoft Entra ID.

## Step 1: register the app in Microsoft Entra (about 5 minutes)

You need an account that can create app registrations (Application Developer, or Global Administrator).

1. Go to <https://entra.microsoft.com> and choose **Identity › Applications › App registrations › New registration**.
2. **Name:** `HDF Studio Review`.
3. **Supported account types:** *Accounts in this organizational directory only (Single tenant)*.
4. **Redirect URI:** choose the platform **Public client/native (mobile & desktop)** and enter `http://localhost`.
   (The app listens on a random local port for the browser to come back; Entra allows any port on
   `http://localhost` for desktop apps.)
5. Select **Register**.
6. On the app's **Overview** page, copy:
   - **Application (client) ID**
   - **Directory (tenant) ID**
7. Open **Authentication** and check that **Allow public client flows** is set to **No** (it isn't needed)
   and that the `http://localhost` redirect is listed under *Mobile and desktop applications*.
8. Open **API permissions**. The default **Microsoft Graph › User.Read** is fine. HDF Studio only asks for
   `openid profile email offline_access` (who you are, and staying signed in). If your tenant blocks user
   consent, select **Grant admin consent for Hive Engineering**.

Optional, to limit review access to a group rather than all staff: open **Enterprise applications ›
HDF Studio Review › Properties**, set **Assignment required** to **Yes**, then add the group under
**Users and groups**.

No client secret or certificate is needed, and none should be created: this is a desktop app, which
can't keep a secret, so it uses PKCE instead.

## Step 2: run the review server

**Hive Engineering:** step 1 is done (tenant `2cc319ea-c91f-4964-92a2-807a20ffe7b6`, app
`8b0d9e7f-df7a-44e9-b939-4961db6bf450`). Ready-made settings are in `deploy/review-server/`:
`Start-ReviewServer.ps1` for a Windows machine, and `hive.env` for the Docker image
(`docker build -t hdf-review .` then
`docker run -p 8787:8787 -v hdf-reviews:/data --env-file deploy/review-server/hive.env hdf-review`).
The server also reads `HDF_MS_TENANT`, `HDF_MS_CLIENT`, `HDF_DOMAIN`, `HDF_DATA` and `PORT` from the
environment, which suits Azure App Service and Container Apps.

The server is part of the `hdfstudio` command line tool (Node.js 20 or later):

```sh
npm run hdfstudio -- review-server --port 8787 --data D:/hdf-reviews \
  --ms-tenant <Directory (tenant) ID> --ms-client <Application (client) ID> --domain hiveng.ca
```

- `--data` is where uploaded PDFs and comments are kept (one folder per review). Back it up with your
  other file shares.
- `--domain` accepts a comma-separated list if you ever need more than one domain.
- It prints `Review server running on port 8787 (Microsoft sign-in, @hiveng.ca only)` when ready.

**Use HTTPS.** Put the server behind your usual reverse proxy or load balancer with a certificate
(for example IIS with URL Rewrite, nginx, Caddy, or an Azure App Service / Container App), and give it a
name such as `https://review.hiveng.ca`. Tokens and documents should never cross a network unencrypted.
Allow long-lived connections (server-sent events at `/api/reviews/<id>/events`) and turn off response
buffering for that path so comments arrive instantly.

To keep it running on Windows, wrap the command with a service manager such as NSSM, or run it as a
scheduled task at startup.

Without `--ms-tenant`, the server can instead use a shared access code (`--token <code>`), which is
fine for a quick trial but doesn't tell you who wrote what.

### On a QNAP NAS (Container Station)

The server image is built automatically by GitHub for Intel/AMD and ARM NAS models
(`ghcr.io/hiveeng/hdf-review:latest`). The NAS only needs to be reachable inside the office
network (and over VPN for remote staff). Microsoft sign-in happens between each PC and Microsoft,
so **don't** forward any ports to the NAS from the internet.

1. Install **Container Station** from the App Center (QTS 5 / QuTS hero 5).
2. In **File Station**, open the **Container** shared folder and create a folder named `hdf-reviews`.
   That's where review PDFs and comments are kept, so your normal NAS backups cover them.
3. The repository is private, so the NAS must log in to GitHub's registry once:
   - On GitHub: **Settings › Developer settings › Personal access tokens › Tokens (classic) ›
     Generate new token**, with only the **read:packages** scope.
   - In Container Station: **Preferences › Registry › Add**. Name `GitHub`, URL `https://ghcr.io`,
     your GitHub username, and the token as the password.
4. In Container Station: **Applications › Create**, name it `hdf-review`, paste the contents of
   [`deploy/review-server/docker-compose.yml`](../deploy/review-server/docker-compose.yml), and
   select **Create**.
5. Check it: open `http://<NAS address>:8787/api/config` in a browser. You should see
   `"auth":"microsoft"` and `hiveng.ca`.
6. HTTPS and a friendly name:
   - Add an internal DNS record, for example `review.hiveng.ca`, pointing at the NAS's address
     (on your router or Windows DNS server).
   - Put a certificate for that name on the NAS (**Control Panel › Security › SSL Certificate &
     Private Key**). A wildcard `*.hiveng.ca` certificate you already own works.
   - **Control Panel › Network & File Services › Network Access › Reverse Proxy › Add**: source
     HTTPS, host `review.hiveng.ca`, port 443; destination HTTP, `localhost`, port 8787.
   - People then use `https://review.hiveng.ca`. (Plain `http://<NAS address>:8787` also works inside
     the office if you skip this step, but sign-in tokens then cross the network unencrypted.)

To update: **Applications › hdf-review › Recreate** (or pull `ghcr.io/hiveeng/hdf-review:latest`
again).

## Step 3: tell people the server address

In HDF Studio:

- **Comment › Shared review** uploads the open PDF, signs in if needed, and copies a link such as
  `https://review.hiveng.ca/r/Ab12Cd34` to send to reviewers.
- **Comment › Join review** opens a review from that link.
- The Comments panel shows who is in the review, when it last synced, and has **Copy link** and
  **Leave**. Saved copies remember their review, so reopening the file reconnects automatically.
- **Sign out of Microsoft** is in the command palette (Ctrl+K).

## Troubleshooting

| Message | What to check |
|---|---|
| `AADSTS50011: redirect URI … does not match` | The registration needs the `http://localhost` redirect under *Mobile and desktop applications* (not *Web* or *Single-page application*). |
| `AADSTS65001: … has not consented` | Grant admin consent on the API permissions page. |
| `AADSTS50105: … not assigned to a role` | Assignment is required and the person isn't in an assigned group. |
| `Sign in with your @hiveng.ca account` | They picked a personal or guest account. Choose the work account in the browser. |
| `Signed in to a different organisation` | `--ms-tenant` must be the Directory (tenant) ID GUID of the tenant people sign in to. |
| `Sign-in token is for another app` | `--ms-client` must match the Application (client) ID the app signed in with. |
| Comments appear only every few seconds | The proxy is buffering `/events`; turn buffering off for that path. |
