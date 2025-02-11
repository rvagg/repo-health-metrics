// Set this with an env var, or put directly in here
const GITHUB_TOKEN = process.env.GITHUB_TOKEN
if (!GITHUB_TOKEN) {
  throw new Error(
    'GITHUB_TOKEN environment variable is required, make a classic one at https://github.com/settings/tokens'
  )
}
// Also note this uses localised date strings, which pick up your system's locale, if that's not
// correct, use `LANG=...` before running the script to set it to the correct locale.

const userActivityGraphql = `
  query($cursor: String, $login: String!, $since: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $since) {
        totalCommitContributions
        totalPullRequestContributions
        totalPullRequestReviewContributions
        totalIssueContributions
        pullRequestContributions(first: 100, after: $cursor) {
          nodes {
            pullRequest {
              title
              number
              repository { nameWithOwner }
              createdAt
              mergedAt
              closedAt
              isDraft
              state
              commits(first: 1) { totalCount }
              additions
              deletions
              comments { totalCount }
              reviews { totalCount }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
        pullRequestReviewContributions(first: 100, after: $cursor) {
          nodes {
            pullRequestReview {
              createdAt
              state
              comments { totalCount }
              repository { nameWithOwner }
              pullRequest {
                number
                title
                author { login }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
        commitContributionsByRepository {
          repository { nameWithOwner }
          contributions {
            totalCount
          }
        }
        issueContributions(first: 100, after: $cursor) {
          nodes {
            issue {
              title
              number 
              repository { nameWithOwner }
              createdAt
              closedAt
              comments { totalCount }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`

async function fetchUserActivity(login, since) {
  let activity = {
    pullRequests: [],
    reviews: [],
    issues: [],
    commitsByRepo: [],
  }
  let hasNextPage = true
  let cursor = null

  while (hasNextPage) {
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        'User-Agent': 'user-activity-collector',
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        query: userActivityGraphql,
        variables: { cursor, login, since },
      }),
    })

    if (response.status !== 200) {
      throw new Error(`Failed to fetch user activity data: ${response.statusText}`)
    }

    const data = await response.json()
    const contributions = data.data.user.contributionsCollection

    // Aggregate all types of contributions
    activity.pullRequests = activity.pullRequests.concat(
      contributions.pullRequestContributions.nodes.map((n) => n.pullRequest)
    )
    activity.reviews = activity.reviews.concat(
      contributions.pullRequestReviewContributions.nodes.map((n) => n.pullRequestReview)
    )
    activity.issues = activity.issues.concat(
      contributions.issueContributions.nodes.map((n) => n.issue)
    )

    if (!activity.commitsByRepo.length) {
      activity.commitsByRepo = contributions.commitContributionsByRepository
    }

    const pageInfo = contributions.pullRequestContributions.pageInfo
    hasNextPage = pageInfo.hasNextPage
    cursor = pageInfo.endCursor
  }

  return activity
}

function shorten(str, maxLength) {
  return str.length > maxLength ? str.slice(0, maxLength) + '…' : str
}

function printActivity(activity) {
  const { pullRequests, reviews, issues, commitsByRepo } = activity

  console.log('\n## Pull Requests')
  console.table(
    pullRequests
      .map((pr) => ({
        State: pr.state,
        Title: shorten(pr.title, 50),
        Created: new Date(pr.createdAt).toLocaleDateString(),
        Merged: pr.mergedAt ? new Date(pr.mergedAt).toLocaleDateString() : '-',
        'Comments/Reviews': `${pr.comments.totalCount}/${pr.reviews.totalCount}`,
        Changes: `+${pr.additions}/-${pr.deletions}`,
        PR: `https://github.com/${pr.repository.nameWithOwner}/pull/${pr.number}`,
      }))
      .reduce((acc, pr) => {
        acc[pr.PR] = pr
        return acc
      }, {}),
    ['Created', 'State', 'Title', 'Merged', 'Comments/Reviews', 'Changes']
  )

  console.log("\n=== Reviews on Others' PRs ===")
  console.table(
    reviews
      .filter((review) => review.pullRequest.author.login !== process.argv[2])
      .map((review) => ({
        Date: new Date(review.createdAt).toLocaleDateString(),
        State: review.state,
        Title: shorten(review.pullRequest.title, 50),
        Author: review.pullRequest.author.login,
        Comments: review.comments.totalCount,
        PR: `https://github.com/${review.repository.nameWithOwner}/pull/${review.pullRequest.number}`,
      }))
      .reduce((acc, review) => {
        acc[review.PR] = review
        return acc
      }, {}),
    ['Date', 'State', 'Title', 'Author']
  )

  console.log('\n## Issues')
  console.table(
    issues
      .map((issue) => ({
        Title: shorten(issue.title, 50),
        Created: new Date(issue.createdAt).toLocaleDateString(),
        Closed: issue.closedAt ? new Date(issue.closedAt).toLocaleDateString() : '-',
        Comments: issue.comments.totalCount,
        Issue: `https://github.com/${issue.repository.nameWithOwner}/issues/${issue.number}`,
      }))
      .reduce((acc, issue) => {
        acc[issue.Issue] = issue
        return acc
      }, {}),
    ['Title', 'Created', 'Closed', 'Comments']
  )

  console.log('\n## Commits by Repository')
  console.table(
    commitsByRepo.map(({ repository, contributions }) => ({
      Repository: repository.nameWithOwner,
      Commits: contributions.totalCount,
    }))
  )
}

async function main() {
  const login = process.argv[2]
  const dateStr = process.argv[3]

  if (!login || !dateStr) {
    console.error('Usage: node activity.js <github-username> <YYYY-MM-DD>')
    process.exit(1)
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/
  if (!dateRegex.test(dateStr)) {
    console.error('Date must be in YYYY-MM-DD format')
    process.exit(1)
  }

  const since = new Date(dateStr)
  if (isNaN(since.getTime())) {
    console.error('Invalid date provided')
    process.exit(1)
  }

  const activity = await fetchUserActivity(login, since.toISOString())
  console.log(`# Activity for @${login} since ${since.toLocaleDateString()}`)
  printActivity(activity)
}

main().catch((error) => {
  console.log(error)
  process.exit(1)
})
