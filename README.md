# repo-health-metrics

Some simple scripting to gather metrics on a GitHub repository related to OSS health and maintainer responsiveness.

## Usage

1. Create a Classic GitHub Personal Access Token (PAT) with the `read:org` scope @ https://github.com/settings/tokens
2. Edit the top of `index.js` to set the parameters for your analysis, including the repository
3. Run with: `GITHUB_TOKEN=ghp_ABC123 node index.js`
