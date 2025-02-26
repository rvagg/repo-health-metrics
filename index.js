// Details of the repository to analyze
const repoSpec = {
  org: 'filecoin-project',
  repo: 'lotus',
  maintainerTeamSlug: 'lotus-maintainers' // maintainer team for "official" interactions
}

// Time period to analyze
const rangeEnd = (() => {
  // 5 days ago
  const date = new Date()
  date.setDate(date.getDate() - 5)
  return date
})()
const rangeStart = (() => {
  // 1 month before the end of the range
  const date = new Date(rangeEnd)
  date.setMonth(rangeEnd.getMonth() - 1)
  return date
})()

// Set this with an env var, or put directly in here
const GITHUB_TOKEN = process.env.GITHUB_TOKEN
if (!GITHUB_TOKEN) {
  throw new Error(
    'GITHUB_TOKEN environment variable is required, make a classic one at https://github.com/settings/tokens'
  )
}

const batchSize = 100

// GraphQL query to fetch PR data, batchSize at a time, with enough information to calculate response times
const graphqlPullRequestQuery = `
query ($cursor: String) {
  repository(owner: "${repoSpec.org}", name: "${repoSpec.repo}") {
    pullRequests(first: ${batchSize}, after: $cursor, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number
        createdAt
        author {
          login
        }
        isDraft
        comments(first: 10) {
          nodes {
            author {
              login
            }
            createdAt
          }
        }
        reviews(first: 10) {
          nodes {
            author {
              login
            }
            createdAt
            state
          }
        }
        timelineItems(first: 10, itemTypes: [CLOSED_EVENT, MERGED_EVENT, READY_FOR_REVIEW_EVENT]) {
          nodes {
            __typename
            ... on ClosedEvent {
              actor {
                login
              }
              createdAt
            }
            ... on MergedEvent {
              actor {
                login
              }
              createdAt
            }
            ... on ReadyForReviewEvent {
              actor {
                login
              }
              createdAt
            }
          }
        }
      }
      pageInfo {
        endCursor
        hasNextPage
      }
    }
  }
}
`

// Fetch maintainers from GitHub team
async function fetchMaintainers () {
  const response = await fetch(
    `https://api.github.com/orgs/${repoSpec.org}/teams/${repoSpec.maintainerTeamSlug}/members`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    }
  )

  if (!response.ok) {
    throw new Error(`Failed to fetch maintainers: ${response.statusText}`)
  }

  const data = await response.json()
  return data.map((member) => member.login)
}

// Fetch PR data from GitHub GraphQL API
async function fetchPRData () {
  let pullRequests = []
  let hasNextPage = true
  let cursor = null

  while (hasNextPage) {
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        'User-Agent': 'repo-health-metrics',
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({
        query: graphqlPullRequestQuery,
        variables: { cursor }
      })
    })

    if (response.status !== 200) {
      throw new Error(`Failed to fetch PR data: ${response.statusText}`)
    }

    const data = await response.json()
    const fetchedPRs = data.data.repository.pullRequests.nodes
    pullRequests = pullRequests.concat(fetchedPRs)

    const pageInfo = data.data.repository.pullRequests.pageInfo
    hasNextPage = pageInfo.hasNextPage
    cursor = pageInfo.endCursor

    // Check the date of the last pull request in the fetched batch
    if (
      fetchedPRs.length > 0 &&
      new Date(fetchedPRs[fetchedPRs.length - 1].createdAt) < rangeStart
    ) {
      break
    }
  }

  // Filter PRs created in the last month
  return pullRequests.filter(
    (pr) =>
      !pr.isDraft && new Date(pr.createdAt) >= rangeStart && new Date(pr.createdAt) <= rangeEnd
  )
}

// Helper function to convert milliseconds to hours and round to the nearest integer
function convertToRoundedHours (milliseconds) {
  return Math.round(milliseconds / (1000 * 60 * 60))
}

// Calculate response times for PRs
function calculateResponseTimes (pullRequests, maintainers) {
  return pullRequests.map((pr) => {
    const prCreatedAt = new Date(pr.createdAt)
    const creator = pr.author.login

    const allEvents = [...pr.comments.nodes, ...pr.reviews.nodes, ...pr.timelineItems.nodes]

    // Find the ReadyForReviewEvent if it exists
    const readyForReviewEvent = allEvents.find(
      (event) => event.__typename === 'ReadyForReviewEvent'
    )

    // Use the ReadyForReviewEvent time as the new creation time if it exists
    const effectiveCreatedAt = readyForReviewEvent
      ? new Date(readyForReviewEvent.createdAt)
      : prCreatedAt

    // An "official" event is one where a known maintainer who isn't the author has responded, or
    // the PR has been closed or merged
    const officialEvent = allEvents.find(
      (event) =>
        (maintainers.includes(event.author?.login || event.actor?.login) &&
          (event.author?.login || event.actor?.login) !== creator) ||
        event.__typename === 'ClosedEvent' ||
        event.__typename === 'MergedEvent'
    )

    // A "non-author" event tells us that there at least weren't crickets
    const nonAuthorEvent = allEvents.find(
      (event) => (event.author?.login || event.actor?.login) !== creator
    )

    const resolvedEvent = allEvents.find(
      (event) => event.__typename === 'ClosedEvent' || event.__typename === 'MergedEvent'
    )

    // Calculate resolution time
    const resolutionTime = resolvedEvent
      ? convertToRoundedHours(new Date(resolvedEvent.createdAt) - effectiveCreatedAt)
      : null

    return {
      number: pr.number,
      createdAt: pr.createdAt,
      resolvedAt: resolvedEvent ? resolvedEvent.createdAt : null,
      resolutionTime,
      maintainer: maintainers.includes(creator),
      creator,
      officialResponseHours: officialEvent
        ? convertToRoundedHours(new Date(officialEvent.createdAt) - prCreatedAt)
        : null,
      nonAuthorResponseHours: nonAuthorEvent
        ? convertToRoundedHours(new Date(nonAuthorEvent.createdAt) - prCreatedAt)
        : null
    }
  })
}

// Main function to orchestrate fetching and processing data
async function main () {
  const maintainers = await fetchMaintainers()
  const pullRequests = await fetchPRData()
  const responseTimes = calculateResponseTimes(pullRequests, maintainers)

  console.log('[\n' + responseTimes.map((rt) => JSON.stringify(rt)).join(',\n') + '\n]')

  responseTimes
    .filter((rt) => rt.officialResponseHours === null)
    .forEach((cricket) => {
      console.log(
        `https://github.com/${repoSpec.org}/${repoSpec.repo}/pull/${cricket.number} created by @${cricket.creator} on ${cricket.createdAt} has had no official response`
      )
    })

  const officiallyResponded = responseTimes.filter((rt) => rt.officialResponseHours !== null)
  const averageOfficialResponseTime = officiallyResponded.reduce(
    (acc, rt) => acc + rt.officialResponseHours,
    0
  )
  console.log(
    `Average official response time: ${
      Math.round((averageOfficialResponseTime / officiallyResponded.length) * 10) / 10
    } hours`
  )

  const resolved = responseTimes.filter((rt) => rt.resolvedAt !== null)
  const averageResolutionTime = resolved.reduce((acc, rt) => acc + rt.resolutionTime, 0)
  console.log(
    `Average resolution time: ${
      Math.round((averageResolutionTime / resolved.length) * 10) / 10
    } hours`
  )
}

main().catch((error) => {
  console.log(error)
  process.exit(1)
})
