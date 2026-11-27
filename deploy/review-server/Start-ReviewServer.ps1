# Run the HDS review server on a Windows machine, signed in with Hive Engineering Microsoft 365 accounts.
# Needs Node.js 20+ and a checkout of this repository (run `npm ci` once in it).
param([int]$Port = 8787, [string]$Data = "C:\HDF-Reviews")
$repo = Resolve-Path "$PSScriptRoot\..\.."
Set-Location $repo
npm run hds -- review-server --port $Port --data $Data `
  --ms-tenant 2cc319ea-c91f-4964-92a2-807a20ffe7b6 `
  --ms-client 8b0d9e7f-df7a-44e9-b939-4961db6bf450 `
  --domain hiveng.ca
