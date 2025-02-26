import { createWriteStream } from 'node:fs'

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
              body
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
        commitContributionsByRepository(maxRepositories: 100) {
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

const contributionsByRepoGraphql = `
  query($owner: String!, $repo: String!, $commitCursor: String, $since: GitTimestamp!) {
    repository(owner: $owner, name: $repo) {
      defaultBranchRef {
        target {
          ... on Commit {
            history(since: $since, first: 100, after: $commitCursor, author: {id: "{{authorId}}"}) {
              nodes {
                messageHeadline
                messageBody
                committedDate
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      }
    }
  }
`

const prCommentsGraphql = `
  query($owner: String!, $repo: String!, $prNumber: Int!, $commentCursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $prNumber) {
        comments(first: 100, after: $commentCursor) {
          nodes {
            author { login }
            bodyText
            createdAt
            reactionGroups {
              content
              reactors { totalCount }
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

const prReviewDetailsGraphql = `
  query($owner: String!, $repo: String!, $prNumber: Int!, $reviewCursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $prNumber) {
        reviews(first: 100, after: $reviewCursor) {
          nodes {
            author { login }
            state
            createdAt
            comments(first: 100) {
              nodes {
                bodyText
                path
                position
                diffHunk
                createdAt
              }
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

const prChangedFilesGraphql = `
  query($owner: String!, $repo: String!, $prNumber: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $prNumber) {
        files(first: 100) {
          nodes {
            path
            additions
            deletions
            changeType
          }
        }
      }
    }
  }
`

const prTimelineGraphql = `
  query($owner: String!, $repo: String!, $prNumber: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $prNumber) {
        timelineItems(first: 100) {
          nodes {
            __typename
            ... on ReadyForReviewEvent {
              actor { login }
              createdAt
            }
            ... on ReviewRequestedEvent {
              actor { login }
              createdAt
              requestedReviewer {
                ... on User { login }
              }
            }
            ... on MergedEvent {
              actor { login }
              createdAt
              commit { oid }
            }
          }
        }
      }
    }
  }
`

const repoInfoGraphql = `
  query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      description
      repositoryTopics(first: 10) {
        nodes {
          topic { name }
        }
      }
    }
  }
`

const userIdGraphql = `
  query($login: String!) {
    user(login: $login) {
      id
    }
  }
`

async function fetchQuery (query, variables) {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'User-Agent': 'user-activity-collector',
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: JSON.stringify({ query, variables })
  })

  if (response.status !== 200) {
    throw new Error(`Failed to fetch user activity data: ${response.statusText}`)
  }

  const data = await response.json()
  if (data.errors) {
    throw new Error(`Failed to fetch user activity data: ${data.errors[0].message}`)
  }
  return data
}

// Fetch all basic activity data for a user
async function fetchUserActivity (login, since) {
  const activity = {
    pullRequests: [],
    reviews: [],
    issues: [],
    commitsByRepo: []
  }
  let hasNextPage = true
  let cursor = null

  const from = new Date(since)
  from.setMonth(from.getMonth() - 1)

  while (hasNextPage) {
    const data = await fetchQuery(userActivityGraphql, { cursor, login, since: from.toISOString() })
    const contributions = data.data.user.contributionsCollection
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
  activity.pullRequests = activity.pullRequests.filter((pr) => new Date(pr.updatedAt) >= since)
  activity.reviews = activity.reviews.filter((review) => new Date(review.updatedAt) >= since)
  activity.issues = activity.issues.filter((issue) => new Date(issue.updatedAt) >= since)

  return activity
}

// Fetch the unique internal GitHub ID for a user
async function fetchUniqueIdForUser (login) {
  const data = await fetchQuery(userIdGraphql, { login })
  return data.data.user.id
}

async function fetchRepoInfo (owner, name) {
  const data = await fetchQuery(repoInfoGraphql, { owner, name })
  return data.data?.repository
}

// Fetch commit contributions for a repository
async function fetchCommitContributionsForRepo (owner, repo, since, authorId) {
  const query = contributionsByRepoGraphql.replace('{{authorId}}', authorId)
  let allCommits = []
  let commitCursor = null
  let hasNextPage = true
  while (hasNextPage) {
    const variables = { owner, repo, commitCursor, since: since.toISOString() }
    const data = await fetchQuery(query, variables)
    const repoData = data.data.repository
    if (!repoData || !repoData.defaultBranchRef || !repoData.defaultBranchRef.target) {
      break
    }
    const history = repoData.defaultBranchRef.target.history
    allCommits = allCommits.concat(history.nodes)
    hasNextPage = history.pageInfo.hasNextPage
    commitCursor = history.pageInfo.endCursor
  }
  return allCommits
}

async function enrichCommitContributions (activity, since, author) {
  const authorId = await fetchUniqueIdForUser(author)
  const queue = []
  for (const repoContribution of activity.commitsByRepo) {
    const repoName = repoContribution.repository.nameWithOwner
    const [owner, repo] = repoName.split('/')
    queue.push(
      (async () => {
        const extraCommits = await fetchCommitContributionsForRepo(owner, repo, since, authorId)
        repoContribution.contributions.nodes = extraCommits
        repoContribution.contributions.directCommits = extraCommits.length
        repoContribution.repoInfo = await fetchRepoInfo(owner, repo)
      })()
    )
  }
  await Promise.all(queue)
  return activity
}

async function fetchPRComments (owner, repo, prNumber) {
  let allComments = []
  let commentCursor = null
  let hasNextPage = true
  while (hasNextPage) {
    const data = await fetchQuery(prCommentsGraphql, { owner, repo, prNumber, commentCursor })
    const comments = data.data?.repository?.pullRequest?.comments
    if (!comments) {
      break
    }
    allComments = allComments.concat(comments.nodes)
    hasNextPage = comments.pageInfo.hasNextPage
    commentCursor = comments.pageInfo.endCursor
  }
  return allComments
}

async function fetchPRReviewDetails (owner, repo, prNumber) {
  let allReviewDetails = []
  let reviewCursor = null
  let hasNextPage = true
  while (hasNextPage) {
    const data = await fetchQuery(prReviewDetailsGraphql, { owner, repo, prNumber, reviewCursor })
    const reviews = data.data?.repository?.pullRequest?.reviews
    if (!reviews) {
      break
    }
    allReviewDetails = allReviewDetails.concat(reviews.nodes)
    hasNextPage = reviews.pageInfo.hasNextPage
    reviewCursor = reviews.pageInfo.endCursor
  }
  return allReviewDetails
}

async function fetchPRChangedFiles (owner, repo, prNumber) {
  const data = await fetchQuery(prChangedFilesGraphql, { owner, repo, prNumber })
  return data.data?.repository?.pullRequest?.files?.nodes || []
}

async function fetchPRTimeline (owner, repo, prNumber) {
  const data = await fetchQuery(prTimelineGraphql, { owner, repo, prNumber })
  return data.data?.repository?.pullRequest?.timelineItems?.nodes || []
}

async function enrichPullRequestData (activity, since) {
  const queue = []
  for (const pr of activity.pullRequests) {
    const owner = pr.repository.nameWithOwner.split('/')[0]
    const repo = pr.repository.nameWithOwner.split('/')[1]
    queue.push(
      (async () => {
        const [comments, reviewDetails, changedFiles, timelineItems] = await Promise.all([
          fetchPRComments(owner, repo, pr.number),
          fetchPRReviewDetails(owner, repo, pr.number),
          fetchPRChangedFiles(owner, repo, pr.number),
          fetchPRTimeline(owner, repo, pr.number)
        ])

        pr.commentDetails = comments.filter((comment) => new Date(comment.createdAt) >= since)
        pr.commentDetails.forEach((comment) => {
          const reactions = comment.reactionGroups.reduce((acc, group) => {
            if (group.reactors.totalCount > 0) {
              acc[group.content] = group.reactors.totalCount
            }
            return acc
          }, {})
          delete comment.reactionGroups
          if (Object.keys(reactions).length) {
            comment.reactions = reactions
          }
        })
        pr.reviewDetails = reviewDetails.filter((review) => new Date(review.createdAt) >= since)
        pr.changedFiles = changedFiles
        pr.timelineItems = timelineItems
      })()
    )
  }
  await Promise.all(queue)
  return activity
}

function shorten (str, maxLength) {
  return str.length > maxLength ? str.slice(0, maxLength) + '…' : str
}

function printActivity (activity, since, format = 'console', enrich = false) {
  const shortenChars = format === 'console' ? 50 : Infinity
  const { pullRequests, reviews, issues, commitsByRepo } = activity

  const print = console.log
  const htmlTable = (headers, data) => {
    print('<table>')
    print('<thead><tr>')
    headers.forEach((header) => print(`<th>${header}</th>`))
    print('</tr></thead>')
    print('<tbody>')
    data.forEach((row) => {
      print('<tr>')
      headers.forEach((header) => print(`<td>${row[header] || ''}</td>`))
      print('</tr>')
    })
    print('</tbody>')
    print('</table>')
  }
  const consoleTable = (headers, data) => {
    console.table(
      data.reduce((acc, item) => {
        const key = Object.values(item)[0]
        acc[key] = item
        return acc
      }, {}),
      headers
    )
  }
  const plainTable = (headers, data) => {
    data.forEach((row) => {
      print(headers.map((header) => `${header}: ${row[header]}`).join(' | '))
    })
  }
  const table = format === 'html' ? htmlTable : format === 'console' ? consoleTable : plainTable

  const heading =
    format === 'html' ? (str) => print(`<h3>${str}</h3>\n`) : (str) => print(`\n## ${str}\n`)

  heading('Pull Requests')

  const prSummary = pullRequests.map((pr) => ({
    State: pr.state,
    Title: `${
      format === 'html'
        ? `<a href="https://github.com/${pr.repository.nameWithOwner}/pull/${pr.number}">${pr.repository.nameWithOwner}/#${pr.number}</a>: `
        : ''
    }${shorten(pr.title, shortenChars)}`,
    Created: new Date(pr.createdAt).toLocaleDateString(),
    Merged: pr.mergedAt ? new Date(pr.mergedAt).toLocaleDateString() : '-',
    'Comments/Reviews': `${pr.comments.totalCount}/${pr.reviews.totalCount}`,
    Changes: `+${pr.additions}/-${pr.deletions}`,
    PR: `https://github.com/${pr.repository.nameWithOwner}/pull/${pr.number}`
  }))

  if (format === 'plain' && enrich) {
    prSummary.forEach((row, idx) => {
      print(
        `PR: ${row.Title} (${row.Created}) | State: ${row.State} | Merged: ${row.Merged} | Comments/Reviews: ${row['Comments/Reviews']} | Changes: ${row.Changes}`
      )
      print('Changed files:')
      pullRequests[idx].changedFiles.forEach((file) => {
        print(`  - ${file.path} (${file.additions} additions, ${file.deletions} deletions)`)
      })
      print('Timeline:')
      pullRequests[idx].timelineItems.forEach((item) => {
        switch (item.__typename) {
          case 'ReadyForReviewEvent':
            print(
              `  - Ready for review by ${item.actor.login} (${new Date(
                item.createdAt
              ).toLocaleDateString()})`
            )
            break
          case 'ReviewRequestedEvent':
            print(
              `  - Review requested from ${item.requestedReviewer?.login || 'a team'} by ${
                item.actor.login
              } (${new Date(item.createdAt).toLocaleDateString()})`
            )
            break
          case 'MergedEvent':
            print(
              `  - Merged by ${item.actor.login} (${new Date(item.createdAt).toLocaleDateString()})`
            )
            break
          default:
            break
        }
      })
      if (new Date(pullRequests[idx].createdAt) >= since) {
        print('Body:')
        if (pullRequests[idx].body) {
          print(pullRequests[idx].body.replace(/^/gm, '  '))
        }
      }
      print('Comments:' + (pullRequests[idx].commentDetails.length ? '' : ' None'))
      pullRequests[idx].commentDetails?.forEach((comment) => {
        print(`  - ${comment.author.login} (${new Date(comment.createdAt).toLocaleDateString()})`)
        print(comment.bodyText.replace(/^/gm, '    '))
      })
      print('Reviews:' + (pullRequests[idx].reviewDetails.length ? '' : ' None'))
      pullRequests[idx].reviewDetails?.forEach((review) => {
        print(`  - ${review.author.login} (${new Date(review.createdAt).toLocaleDateString()})`)
        print(`    State: ${review.state}`)
        review.comments.nodes.forEach((comment) => {
          print(`    - ${comment.bodyText}`)
        })
      })
      print('')
    })
  } else {
    table(
      ['Created', 'State', 'Title', 'Merged', 'Comments/Reviews', 'Changes'].concat(
        format === 'html' ? [] : ['PR']
      ),
      prSummary
    )
  }

  heading('Issues')
  table(
    ['Created', 'Title', 'Closed', 'Comments'].concat(format === 'html' ? [] : ['Issue']),
    issues.map((issue) => ({
      Title: `${
        format === 'html'
          ? `<a href="https://github.com/${issue.repository.nameWithOwner}/issues/${issue.number}">${issue.repository.nameWithOwner}/#${issue.number}</a>: `
          : ''
      }${shorten(issue.title, shortenChars)}`,
      Created: new Date(issue.createdAt).toLocaleDateString(),
      Closed: issue.closedAt ? new Date(issue.closedAt).toLocaleDateString() : '-',
      Comments: issue.comments.totalCount,
      Issue: `https://github.com/${issue.repository.nameWithOwner}/issues/${issue.number}`
    }))
  )

  heading('Reviews')
  table(
    ['Date', 'State', 'Title', 'Author', 'Comments'].concat(format === 'html' ? [] : ['PR']),
    reviews
      .filter((review) => review.pullRequest.author.login !== process.argv[2])
      .map((review) => ({
        Date: new Date(review.createdAt).toLocaleDateString(),
        State: review.state,
        Title: `${
          format === 'html'
            ? `<a href="https://github.com/${review.repository.nameWithOwner}/pull/${review.pullRequest.number}">${review.repository.nameWithOwner}#${review.pullRequest.number}</a>: `
            : ''
        }${shorten(review.pullRequest.title, shortenChars)}`,
        Author: review.pullRequest.author.login,
        Comments: review.comments.totalCount,
        PR: `https://github.com/${review.repository.nameWithOwner}/pull/${review.pullRequest.number}`
      }))
  )

  heading('Commits by Repository')
  if (format === 'plain' && enrich) {
    commitsByRepo.forEach(({ repository, contributions, repoInfo }) => {
      print(
        `Repository: ${repository.nameWithOwner} (${repoInfo.description || ''}${
          repoInfo.repositoryTopics.nodes.length
            ? ' [' + repoInfo.repositoryTopics.nodes.map((t) => t.topic.name).join(', ') + ']'
            : ''
        }), Contributions: ${contributions.totalCount}, Commits landed: ${
          contributions.directCommits
        }`
      )
      contributions.nodes.forEach((commit) => {
        print(
          `  - ${commit.messageHeadline} (${new Date(commit.committedDate).toLocaleDateString()})`
        )
        if (commit.messageBody) {
          print(commit.messageBody.replace(/^/gm, '    '))
        }
      })
      if (contributions.nodes.length) {
        print('')
      }
    })
  } else {
    table(
      ['Repository', 'Commits'],
      commitsByRepo.map(({ repository, contributions }) => ({
        Repository: repository.nameWithOwner,
        Commits: contributions.totalCount
      }))
    )
  }
}

function parseArgs (args) {
  const parsedArgs = {
    login: null,
    since: null,
    outputs: [],
    enrich: false
  }

  // Extract username and date
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--enrich') {
      parsedArgs.enrich = true
    } else if (arg === '--format' || arg === '--output') {
      // Skip these for now, we'll handle them separately
      i++
    } else if (!arg.startsWith('--') && !parsedArgs.login) {
      parsedArgs.login = arg
    } else if (!arg.startsWith('--') && !parsedArgs.dateStr) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
        throw new Error('Date must be in YYYY-MM-DD format')
      }
      parsedArgs.since = new Date(arg)
      if (isNaN(parsedArgs.since.getTime())) {
        console.error('Invalid date provided')
        process.exit(1)
      }
    } else {
      throw new Error(`Invalid argument: ${arg}`)
    }
  }

  // Handle output formats - support both legacy --format and new --output
  const outputIdx = args.indexOf('--output')
  const formatIdx = args.indexOf('--format')

  if (outputIdx !== -1 && outputIdx + 1 < args.length) {
    // Parse the new --output format with destinations
    const outputSpecs = args[outputIdx + 1].split(',')

    for (const spec of outputSpecs) {
      const parts = spec.split(':')
      const format = parts[0]
      const destination = parts.length > 1 ? parts[1] : 'stdout'

      if (!['html', 'console', 'plain', 'json'].includes(format)) {
        throw new Error(`Invalid output format: ${format}`)
      }

      parsedArgs.outputs.push({ format, destination })
    }
  } else if (formatIdx !== -1 && formatIdx + 1 < args.length) {
    // Support legacy --format option (outputs to stdout)
    const format = args[formatIdx + 1]
    if (!['html', 'console', 'plain', 'json'].includes(format)) {
      throw new Error('Invalid format provided')
    }
    parsedArgs.outputs.push({ format, destination: 'stdout' })
  } else {
    // Default to console to stdout
    parsedArgs.outputs.push({ format: 'console', destination: 'stdout' })
  }

  // Validate required arguments
  if (!parsedArgs.login || !parsedArgs.since) {
    throw new Error(
      `Usage: node activity.js <github-username> <YYYY-MM-DD> [options]

Options:
  --enrich                   Fetch additional data for richer output
  --output <format:dest>     Specify output format and destination
                             Multiple outputs can be comma-separated
                             
Formats:
  - console[:filename]       Console format (default if no format specified)
  - html[:filename]          HTML format
  - plain[:filename]         Plain text format
  - json[:filename]          JSON format (best for LLM processing)

Examples:
  node activity.js octocat 2023-01-01
  node activity.js octocat 2023-01-01 --enrich
  node activity.js octocat 2023-01-01 --output html:report.html
  node activity.js octocat 2023-01-01 --output "html:report.html,plain:details.txt,json:data.json" --enrich`
    )
  }

  return parsedArgs
}

// Helper function for JSON output
function generateJsonOutput (activity, login, since) {
  const { pullRequests, reviews, issues, commitsByRepo } = activity

  return {
    username: login,
    period: {
      start: since.toISOString(),
      end: new Date().toISOString()
    },
    stats: {
      totalPRs: pullRequests.length,
      totalReviews: reviews.length,
      totalIssues: issues.length,
      totalCommitRepos: commitsByRepo.length,
      totalCommits: commitsByRepo.reduce(
        (sum, repo) => sum + (repo.contributions.directCommits || 0),
        0
      )
    },
    // Include enriched data when available
    pullRequests: pullRequests.map((pr) => ({
      title: pr.title,
      url: `https://github.com/${pr.repository.nameWithOwner}/pull/${pr.number}`,
      repo: pr.repository.nameWithOwner,
      number: pr.number,
      state: pr.state,
      created: pr.createdAt,
      merged: pr.mergedAt,
      additions: pr.additions,
      deletions: pr.deletions,
      commentCount: pr.comments.totalCount,
      reviewCount: pr.reviews.totalCount,
      body: pr.body,
      // Include enriched data if available
      commentDetails: pr.commentDetails,
      reviewDetails: pr.reviewDetails,
      changedFiles: pr.changedFiles,
      timelineItems: pr.timelineItems
    })),
    issues,
    reviews,
    commitsByRepo
  }
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const { login, since, outputs, enrich } = args

  const activity = await fetchUserActivity(login, since)

  if (enrich) {
    await Promise.all([
      enrichCommitContributions(activity, since, login),
      enrichPullRequestData(activity, since)
    ])
  }

  for (const { format, destination } of outputs) {
    let outputStream

    if (destination === 'stdout') {
      outputStream = process.stdout
    } else {
      outputStream = createWriteStream(destination)
      console.error(`Writing ${format} output to ${destination}...`)
    }

    // Print to the selected output stream
    const originalConsoleLog = console.log
    console.log = (...args) => {
      outputStream.write(args.join(' ') + '\n')
    }

    // Generate header
    console.log(
      `${
        format === 'html' ? '<h2>' : '# '
      }Activity for @${login} since ${since.toLocaleDateString()}${
        format === 'html' ? '</h2>' : ''
      }`
    )

    // Special case for JSON format
    if (format === 'json') {
      console.log(JSON.stringify(generateJsonOutput(activity, login, since), null, 2))
    } else {
      printActivity(activity, since, format, enrich)
    }

    // Restore console.log
    console.log = originalConsoleLog

    // Close file streams if not stdout
    if (destination !== 'stdout') {
      outputStream.end()
    }
  }
}

main().catch((error) => {
  console.log(error)
  process.exit(1)
})
