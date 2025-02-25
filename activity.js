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
              updatedAt
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
              updatedAt
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
              updatedAt
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

  // Calculate the date a month prior to the specified date
  const from = new Date(since)
  from.setMonth(from.getMonth() - 1)

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
        variables: { cursor, login, since: from.toISOString() },
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

  // Filter contributions to include only those updated since the specified date
  activity.pullRequests = activity.pullRequests.filter(pr => new Date(pr.updatedAt) >= since)
  activity.reviews = activity.reviews.filter(review => new Date(review.updatedAt) >= since)
  activity.issues = activity.issues.filter(issue => new Date(issue.updatedAt) >= since)

  return activity
}

function shorten(str, maxLength) {
  return str.length > maxLength ? str.slice(0, maxLength) + '…' : str
}

function printActivity(activity, htmlOutput = false) {
  const shortenChars = htmlOutput ? Infinity : 50
  const { pullRequests, reviews, issues, commitsByRepo } = activity

  const log = htmlOutput ? (str) => console.log(str) : (str) => console.log(str)
  const table = htmlOutput
    ? (headers, data) => {
        log('<table>')
        log('<thead><tr>')
        headers.forEach((header) => log(`<th>${header}</th>`))
        log('</tr></thead>')
        log('<tbody>')
        data.forEach((row) => {
          log('<tr>')
          headers.forEach((header) => log(`<td>${row[header] || ''}</td>`))
          log('</tr>')
        })
        log('</tbody>')
        log('</table>')
      }
    : (headers, data) => console.table(data.reduce((acc, item) => {
        const key = Object.values(item)[0];
        acc[key] = item;
        return acc;
      }, {}), headers);

  const heading = htmlOutput ? (str) => log(`<h3>${str}</h3>`) : (str) => console.log(`\n## ${str}`)

  heading('Pull Requests')
  table(
    ['Created', 'State', 'Title', 'Merged', 'Comments/Reviews', 'Changes'].concat(htmlOutput ? [] : ['PR']),
    pullRequests.map((pr) => ({
      State: pr.state,
      Title: `${htmlOutput ? `<a href="https://github.com/${pr.repository.nameWithOwner}/pull/${pr.number}">` : ''}${shorten(pr.title, shortenChars)}${htmlOutput ? '</a>' : ''}`,
      Created: new Date(pr.createdAt).toLocaleDateString(),
      Merged: pr.mergedAt ? new Date(pr.mergedAt).toLocaleDateString() : '-',
      'Comments/Reviews': `${pr.comments.totalCount}/${pr.reviews.totalCount}`,
      Changes: `+${pr.additions}/-${pr.deletions}`,
      PR: `https://github.com/${pr.repository.nameWithOwner}/pull/${pr.number}`,
    }))
  )

  heading('Issues')
  table(
    ['Created', 'Title', 'Closed', 'Comments'].concat(htmlOutput ? [] : ['Issue']),
    issues.map((issue) => ({
      Title: `${htmlOutput ? `<a href="https://github.com/${issue.repository.nameWithOwner}/issues/${issue.number}">` : ''}${shorten(issue.title, shortenChars)}${htmlOutput ? '</a>' : ''}`,
      Created: new Date(issue.createdAt).toLocaleDateString(),
      Closed: issue.closedAt ? new Date(issue.closedAt).toLocaleDateString() : '-',
      Comments: issue.comments.totalCount,
      Issue: `https://github.com/${issue.repository.nameWithOwner}/issues/${issue.number}`,
    }))
  )

  heading('Reviews')
  table(
    ['Date', 'State', 'Title', 'Author', 'Comments'].concat(htmlOutput ? [] : ['PR']),
    reviews
      .filter((review) => review.pullRequest.author.login !== process.argv[2])
      .map((review) => ({
        Date: new Date(review.createdAt).toLocaleDateString(),
        State: review.state,
        Title: shorten(review.pullRequest.title, shortenChars),
        Title: `${htmlOutput ? `<a href="https://github.com/${review.repository.nameWithOwner}/pull/${review.pullRequest.number}">` : ''}${shorten(review.pullRequest.title, shortenChars)}${htmlOutput ? '</a>' : ''}`,
        Author: review.pullRequest.author.login,
        Comments: review.comments.totalCount,
        PR: `https://github.com/${review.repository.nameWithOwner}/pull/${review.pullRequest.number}`,
      }))
  )

  heading('Commits by Repository')
  table(
    ['Repository', 'Commits'],
    commitsByRepo.map(({ repository, contributions }) => ({
      Repository: repository.nameWithOwner,
      Commits: contributions.totalCount,
    }))
  )
}

async function main() {
  const login = process.argv[2]
  const dateStr = process.argv[3]
  const htmlOutput = process.argv.includes('--html')

  if (!login || !dateStr) {
    console.error('Usage: node activity.js <github-username> <YYYY-MM-DD> [--html]')
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

  const activity = await fetchUserActivity(login, since)
  if (htmlOutput) {
    console.log(`<h2>Activity for @${login} since ${since.toLocaleDateString()}</h2>`)
  } else {
    console.log(`# Activity for @${login} since ${since.toLocaleDateString()}`)
  }
  printActivity(activity, htmlOutput)
}

main().catch((error) => {
  console.log(error)
  process.exit(1)
})
