# Publishing `@panom/arc`

This checklist is for releasing `@panom/arc` as a public npm package.

## 1. Create the package repository

Create a public GitHub repository, for example:

- `panom-arc`
- or `your-org/panom-arc`

Push the contents of this directory there.

After that, update `package.json` with real metadata:

- `repository`
- `homepage`
- `bugs`
- optionally `author`

## 2. Create an npm account

If you do not already have one:

1. Go to [https://www.npmjs.com/signup](https://www.npmjs.com/signup)
2. Verify your email
3. Enable 2FA if you want stronger publish security

## 3. Log in from your terminal

```bash
npm login
```

Verify the active account:

```bash
npm whoami
```

## 4. Make sure the scope is publishable

For a scoped package like `@panom/arc`, public publishing must use:

```bash
npm publish --access public
```

That is already reflected in the package metadata through:

```json
"publishConfig": {
  "access": "public"
}
```

Important:

- the npm scope `@panom` must belong to your npm user or npm organization
- if it does not, rename the package before publishing, for example `@your-scope/panom-arc`

## 5. Run the release checks

From the `panom-arc` directory:

```bash
npm run pack:check
npm run selftest
```

What these do:

- `pack:check` shows the exact files that will be published
- `selftest` validates the detector, realistic camera simulation, auth loop, and network resilience

## 6. Bump the version

Choose one:

```bash
npm version patch
npm version minor
npm version major
```

Or edit `package.json` manually if you prefer.

## 7. Publish

```bash
npm publish --access public
```

If the publish succeeds, npm will return the published version and package URL.

## 8. Install it in the frontend and backend repos

Replace local file references like:

```json
"@panom/arc": "file:../panom-arc"
```

with a registry version:

```json
"@panom/arc": "^0.1.0"
```

Then run:

```bash
npm install
```

in both:

- `panom-frontend`
- `panom-backend`

## 9. Update GitHub Actions

Once both apps depend on the published npm version, GitHub Actions no longer needs local sibling access to `../panom-arc`.

That is the main fix for the CI resolution issue.

## 10. Recommended release routine

For every release:

1. update code
2. run `npm run pack:check`
3. run `npm run selftest`
4. bump version
5. publish
6. update consuming apps to the new version

## Troubleshooting

### `403 Forbidden` on publish

Usually one of these:

- you are not logged into the correct npm account
- the package scope belongs to another npm org/user
- you forgot `--access public`

### `402 Payment Required`

This often appears for scoped packages when npm treats the publish as private. Use:

```bash
npm publish --access public
```

### Consumers still cannot resolve `@panom/arc`

Check:

1. the version is actually published
2. `package.json` in consumers uses the registry version, not `file:...`
3. `package-lock.json` was regenerated
4. CI is running `npm ci` after the dependency update
