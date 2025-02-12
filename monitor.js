import repos from './repos.js'

// Get token from environment variable
const GITHUB_TOKEN = process.env.GITHUB_TOKEN
if (!GITHUB_TOKEN) {
  throw new Error('GITHUB_TOKEN environment variable is required')
}

// Add webhook URL from Slack workflow
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

const MONITOR_QUERY = `
query($cursor: String, $owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(
      first: 100, 
      after: $cursor, 
      states: [OPEN], 
      orderBy: {field: CREATED_AT, direction: DESC}
    ) {
      nodes {
        number
        title
        createdAt
        state
        isDraft
        url
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
`

async function fetchRepoMetrics(repo) {
  let prs = []
  let hasNextPage = true
  let cursor = null

  while (hasNextPage) {
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        'User-Agent': 'repo-monitor',
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        query: MONITOR_QUERY,
        variables: { cursor, owner: repo.org, name: repo.repo }
      })
    })

    if (!response.ok) {
      throw new Error(`Failed to fetch data for ${repo.org}/${repo.repo}: ${response.statusText}`)
    }

    const data = await response.json()
    
    if (!data || !data.data) {
      console.error('API Response:', data)
      throw new Error(`Invalid response for ${repo.org}/${repo.repo}`)
    }

    if (data.errors) {
      console.error('GraphQL Errors:', data.errors)
      throw new Error(`GraphQL error for ${repo.org}/${repo.repo}: ${data.errors[0].message}`)
    }

    const repository = data.data.repository
    if (!repository) {
      throw new Error(`Repository ${repo.org}/${repo.repo} not found or access denied`)
    }

    repository.pullRequests.nodes.forEach(pr => {
      if (!pr.isDraft) {
        prs.push({
          created: new Date(pr.createdAt).toLocaleDateString(),
          state: pr.state,
          title: pr.title,
          _url: pr.url
        })
      }
    })

    hasNextPage = repository.pullRequests.pageInfo.hasNextPage
    cursor = repository.pullRequests.pageInfo.endCursor
  }

  return prs
}

async function triggerSlackWorkflow(prs, repo) {
  if (!SLACK_WEBHOOK_URL) return;

  try {
    let message = `*FilOz Metrics - ${repo.org}/${repo.repo}*\n`;

    if (prs.length > 0) {
      // Create table header
      message += '```\n' + 
        'PR #'.padEnd(8) + ' | ' +
        'Created'.padEnd(10) + ' | ' +
        'Title'.padEnd(50) +
        '\n';

      // Add PRs
      prs.forEach(pr => {
        const prNumber = `#${pr._url.split('/').pop()}`;
        message += 
          `• <${pr._url}|${prNumber.padEnd(6)}> | ` +
          `${pr.created.padEnd(10)} | ` +
          `${pr.title.substring(0, 48).padEnd(50)}\n`;
      });
      message += '```';
    } else {
      message += '\n🎉 No open pull requests found!';
    }

    const payload = {
      blocks: message
    };

    const response = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Webhook error: ${response.statusText}`);
    }
  } catch (error) {
    console.error('Error triggering Slack workflow:', error);
  }
}

async function main() {
  console.log(`Monitoring PRs for ${repos.length} repositories...`)

  for (const repo of repos) {
    try {
      const prs = await fetchRepoMetrics(repo)
      
      // Console output
      console.log(`\n${prs.length} Pull Requests for ${repo.org}/${repo.repo}:`)
      if (prs.length > 0) {
        const tableData = prs.reduce((acc, pr) => {
          acc[pr._url] = {
            created: pr.created,
            state: pr.state,
            title: pr.title
          }
          return acc
        }, {})
        console.table(tableData)
      } else {
        console.table([])
      }

      // Slack output
      if (SLACK_WEBHOOK_URL) {
        await triggerSlackWorkflow(prs, repo);
      }
    } catch (error) {
      console.error(`Error fetching PRs for ${repo.org}/${repo.repo}:`, error)
    }
  }
}

main().catch(error => {
  console.error('Error:', error)
  process.exit(1)
})
