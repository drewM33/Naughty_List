const express = require('express');
const { TwitterApi } = require('twitter-api-v2');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');
const path = require('path');
const https = require('https');
const http = require('http');
require('dotenv').config();

// Initialize Anthropic client (support both key names)
const anthropicKey = process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY;
const anthropic = anthropicKey 
  ? new Anthropic({ apiKey: anthropicKey })
  : null;

if (anthropic) {
  console.log('✅ Anthropic API initialized');
} else {
  console.log('⚠️ ANTHROPIC_KEY or ANTHROPIC_API_KEY not found - Santa Chat will be disabled');
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// List of Nitter instances to try (free Twitter frontends with RSS feeds)
const NITTER_INSTANCES = [
  'nitter.net',
  'nitter.poast.org',
  'nitter.privacydev.net',
  'nitter.1d4.us',
  'nitter.kavin.rocks',
  'nitter.unixfox.eu',
];

// Fetch data from URL
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const request = protocol.get(url, { 
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 10000
    }, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        return fetchUrl(response.headers.location).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => resolve(data));
    });
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Timeout'));
    });
  });
}

// Parse Nitter RSS feed to extract tweets
function parseNitterRSS(xml, username) {
  const tweets = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  
  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    const titleMatch = item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/);
    const descMatch = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/);
    const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/);
    const dateMatch = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    
    if (titleMatch || descMatch) {
      // Clean HTML from description
      let text = (descMatch ? descMatch[1] : titleMatch[1])
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
      
      if (text.length > 0) {
        tweets.push({
          text,
          link: linkMatch ? linkMatch[1] : '',
          date: dateMatch ? dateMatch[1] : ''
        });
      }
    }
  }
  
  return tweets;
}

// Fetch tweets from Nitter (free, no API key needed!)
async function fetchNitterTweets(username) {
  for (const instance of NITTER_INSTANCES) {
    try {
      const url = `https://${instance}/${username}/rss`;
      console.log(`Trying Nitter instance: ${url}`);
      
      const xml = await fetchUrl(url);
      
      if (xml && xml.includes('<item>')) {
        const tweets = parseNitterRSS(xml, username);
        if (tweets.length > 0) {
          console.log(`✅ Got ${tweets.length} tweets from ${instance}`);
          return { tweets, instance };
        }
      }
    } catch (err) {
      console.log(`❌ ${instance} failed: ${err.message}`);
    }
  }
  return { tweets: [], instance: null };
}

// Twitter API client (as backup)
let twitterClient = null;

async function initTwitterClient() {
  if (twitterClient) return twitterClient;
  
  try {
    const appOnlyClient = new TwitterApi({
      appKey: process.env.API_KEY,
      appSecret: process.env.API_SECRET_KEY,
    });
    twitterClient = await appOnlyClient.appLogin();
    console.log('✅ Twitter API Bearer Token obtained');
    return twitterClient;
  } catch (err) {
    console.log('ℹ️  Twitter API not available, using Nitter');
    return null;
  }
}

initTwitterClient().catch(() => {});

// ==========================================
// REDDIT API INTEGRATION
// ==========================================
let redditAccessToken = null;
let redditTokenExpiry = 0;

async function getRedditToken() {
  if (redditAccessToken && Date.now() < redditTokenExpiry) {
    return redditAccessToken;
  }
  
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  
  if (!clientId || !clientSecret) {
    console.log('⚠️ Reddit credentials not configured');
    return null;
  }
  
  try {
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'NaughtyNiceChecker/1.0'
      },
      body: 'grant_type=client_credentials'
    });
    
    const data = await response.json();
    if (data.access_token) {
      redditAccessToken = data.access_token;
      redditTokenExpiry = Date.now() + (data.expires_in * 1000) - 60000;
      console.log('✅ Reddit access token obtained');
      return redditAccessToken;
    }
  } catch (err) {
    console.log('❌ Reddit auth failed:', err.message);
  }
  return null;
}

async function fetchRedditData(username) {
  try {
    const token = await getRedditToken();
    const headers = {
      'User-Agent': 'NaughtyNiceChecker/1.0'
    };
    
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    
    // Fetch user's recent comments
    const response = await fetch(`https://www.reddit.com/user/${username}/comments.json?limit=50`, {
      headers
    });
    
    if (!response.ok) {
      console.log(`Reddit user ${username} not found or private`);
      return { comments: [], found: false };
    }
    
    const data = await response.json();
    const comments = (data.data?.children || []).map(child => ({
      text: child.data.body,
      score: child.data.score,
      subreddit: child.data.subreddit
    }));
    
    console.log(`✅ Reddit: Found ${comments.length} comments for u/${username}`);
    return { comments, found: true };
  } catch (err) {
    console.log('❌ Reddit fetch failed:', err.message);
    return { comments: [], found: false };
  }
}

function analyzeRedditComments(comments) {
  let naughtyCount = 0;
  let niceCount = 0;
  
  comments.forEach(comment => {
    const text = comment.text.toLowerCase();
    
    NAUGHTY_KEYWORDS.forEach(keyword => {
      if (text.includes(keyword)) naughtyCount++;
    });
    
    NICE_KEYWORDS.forEach(keyword => {
      if (text.includes(keyword)) niceCount++;
    });
    
    // Negative karma comments are naughty
    if (comment.score < 0) naughtyCount += 2;
    // High karma comments are nice
    if (comment.score > 10) niceCount++;
  });
  
  const score = Math.max(0, Math.min(100, 50 + (niceCount - naughtyCount) * 3));
  
  return {
    score,
    verdict: score >= 50 ? 'NICE' : 'NAUGHTY',
    niceCount,
    naughtyCount,
    commentsAnalyzed: comments.length
  };
}

// ==========================================
// DUCKDUCKGO NEWS SEARCH INTEGRATION
// ==========================================
async function fetchNewsData(searchTerm) {
  try {
    // Use DuckDuckGo HTML search and parse results
    const query = encodeURIComponent(`${searchTerm} news`);
    const url = `https://html.duckduckgo.com/html/?q=${query}`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const html = await response.text();
    
    // Extract result snippets
    const snippets = [];
    const resultRegex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let match;
    
    while ((match = resultRegex.exec(html)) !== null && snippets.length < 20) {
      const text = match[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .trim();
      if (text.length > 20) {
        snippets.push({ text });
      }
    }
    
    // Also extract titles
    const titleRegex = /<a class="result__a"[^>]*>([\s\S]*?)<\/a>/g;
    while ((match = titleRegex.exec(html)) !== null && snippets.length < 30) {
      const text = match[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .trim();
      if (text.length > 10) {
        snippets.push({ text });
      }
    }
    
    console.log(`✅ News: Found ${snippets.length} news snippets for "${searchTerm}"`);
    return { snippets, found: snippets.length > 0 };
  } catch (err) {
    console.log('❌ News fetch failed:', err.message);
    return { snippets: [], found: false };
  }
}

// News-specific keywords
const NEWS_NAUGHTY_KEYWORDS = [
  'scandal', 'controversy', 'arrested', 'accused', 'lawsuit', 'fired', 
  'criticized', 'backlash', 'outrage', 'apologizes', 'admits', 'investigation',
  'fraud', 'scam', 'criminal', 'guilty', 'convicted', 'allegations'
];

const NEWS_NICE_KEYWORDS = [
  'awarded', 'honored', 'praised', 'celebrates', 'donates', 'charity',
  'hero', 'saves', 'helps', 'achievement', 'breakthrough', 'success',
  'philanthropist', 'volunteer', 'recognition', 'inspiring', 'beloved'
];

function analyzeNewsSnippets(snippets) {
  let naughtyCount = 0;
  let niceCount = 0;
  
  snippets.forEach(snippet => {
    const text = snippet.text.toLowerCase();
    
    NEWS_NAUGHTY_KEYWORDS.forEach(keyword => {
      if (text.includes(keyword)) naughtyCount++;
    });
    
    NEWS_NICE_KEYWORDS.forEach(keyword => {
      if (text.includes(keyword)) niceCount++;
    });
    
    // Also check general keywords
    NAUGHTY_KEYWORDS.forEach(keyword => {
      if (text.includes(keyword)) naughtyCount++;
    });
    
    NICE_KEYWORDS.forEach(keyword => {
      if (text.includes(keyword)) niceCount++;
    });
  });
  
  const score = Math.max(0, Math.min(100, 50 + (niceCount - naughtyCount) * 4));
  
  return {
    score,
    verdict: score >= 50 ? 'NICE' : 'NAUGHTY',
    niceCount,
    naughtyCount,
    snippetsAnalyzed: snippets.length
  };
}

// ==========================================
// GITHUB API INTEGRATION
// ==========================================
async function fetchGitHubData(username) {
  try {
    // Fetch user profile
    const userResponse = await fetch(`https://api.github.com/users/${username}`, {
      headers: {
        'User-Agent': 'NaughtyNiceChecker/1.0',
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    
    if (!userResponse.ok) {
      console.log(`GitHub user ${username} not found`);
      return { user: null, events: [], found: false };
    }
    
    const user = await userResponse.json();
    
    // Fetch recent events
    const eventsResponse = await fetch(`https://api.github.com/users/${username}/events/public?per_page=30`, {
      headers: {
        'User-Agent': 'NaughtyNiceChecker/1.0',
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    
    const events = eventsResponse.ok ? await eventsResponse.json() : [];
    
    console.log(`✅ GitHub: Found user ${username} with ${user.public_repos} repos`);
    return { user, events, found: true };
  } catch (err) {
    console.log('❌ GitHub fetch failed:', err.message);
    return { user: null, events: [], found: false };
  }
}

function analyzeGitHubData(data) {
  if (!data.user) {
    return { score: 50, verdict: 'NICE', details: 'No GitHub data' };
  }
  
  let niceScore = 0;
  
  // Contributions are nice
  if (data.user.public_repos > 0) niceScore += Math.min(data.user.public_repos * 2, 20);
  if (data.user.followers > 0) niceScore += Math.min(data.user.followers, 15);
  
  // Bio/profile completeness is nice
  if (data.user.bio) niceScore += 5;
  if (data.user.blog) niceScore += 5;
  
  // Recent activity
  const pushEvents = data.events.filter(e => e.type === 'PushEvent').length;
  const prEvents = data.events.filter(e => e.type === 'PullRequestEvent').length;
  const issueEvents = data.events.filter(e => e.type === 'IssuesEvent').length;
  
  niceScore += pushEvents * 2;
  niceScore += prEvents * 3; // PRs to other repos = collaboration
  niceScore += issueEvents; // Helping with issues
  
  const score = Math.min(100, 50 + niceScore);
  
  return {
    score,
    verdict: score >= 50 ? 'NICE' : 'NAUGHTY',
    repos: data.user.public_repos,
    followers: data.user.followers,
    recentActivity: data.events.length
  };
}

// ==========================================
// WEIGHTED SCORE CALCULATOR
// ==========================================
const SCORE_WEIGHTS = {
  twitter: 0.30,   // 30%
  reddit: 0.30,    // 30%
  news: 0.30,      // 30%
  github: 0.10     // 10%
};

function calculateWeightedScore(sources) {
  let totalWeight = 0;
  let weightedSum = 0;
  const breakdown = {};
  
  for (const [source, data] of Object.entries(sources)) {
    if (data && data.found !== false && data.score !== undefined) {
      const weight = SCORE_WEIGHTS[source] || 0;
      weightedSum += data.score * weight;
      totalWeight += weight;
      breakdown[source] = {
        score: data.score,
        weight: Math.round(weight * 100) + '%',
        verdict: data.verdict,
        ...data
      };
    }
  }
  
  // Redistribute weight if some sources are missing
  const finalScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 50;
  
  return {
    finalScore,
    verdict: finalScore >= 50 ? 'NICE' : 'NAUGHTY',
    breakdown,
    sourcesFound: Object.keys(breakdown).length
  };
}

// Naughty words and phrases
const NAUGHTY_KEYWORDS = [
  'hate', 'angry', 'stupid', 'idiot', 'dumb', 'terrible', 'worst', 'bad', 
  'awful', 'horrible', 'annoying', 'trash', 'garbage', 'sucks', 'pathetic',
  'loser', 'fail', 'failure', 'disgusting', 'nasty', 'ugly', 'boring',
  'liar', 'fake', 'fraud', 'scam', 'cheat', 'steal', 'kill', 'die',
  'shut up', 'go away', 'leave me alone', 'i dont care', 'whatever',
  'complain', 'whine', 'cry', 'blame', 'fault', 'rude', 'mean', 'cruel'
];

// Nice words and phrases
const NICE_KEYWORDS = [
  'love', 'happy', 'grateful', 'thankful', 'appreciate', 'kind', 'help',
  'support', 'care', 'wonderful', 'amazing', 'awesome', 'great', 'excellent',
  'beautiful', 'fantastic', 'incredible', 'brilliant', 'perfect', 'best',
  'friend', 'family', 'together', 'share', 'give', 'donate', 'volunteer',
  'inspire', 'encourage', 'motivate', 'celebrate', 'congratulations', 'congrats',
  'thank you', 'thanks', 'please', 'sorry', 'welcome', 'bless', 'blessed',
  'joy', 'peace', 'hope', 'dream', 'believe', 'trust', 'faith', 'smile'
];

// Analyze tweets for naughty/nice score
function analyzeTweets(tweets) {
  let naughtyCount = 0;
  let niceCount = 0;
  let naughtyExamples = [];
  let niceExamples = [];
  
  tweets.forEach(tweet => {
    const text = tweet.text.toLowerCase();
    let tweetNaughty = 0;
    let tweetNice = 0;
    
    NAUGHTY_KEYWORDS.forEach(keyword => {
      if (text.includes(keyword)) {
        tweetNaughty++;
        naughtyCount++;
      }
    });
    
    NICE_KEYWORDS.forEach(keyword => {
      if (text.includes(keyword)) {
        tweetNice++;
        niceCount++;
      }
    });
    
    if (tweetNaughty > tweetNice && naughtyExamples.length < 3) {
      naughtyExamples.push({
        text: tweet.text,
        keywords: NAUGHTY_KEYWORDS.filter(k => text.includes(k))
      });
    } else if (tweetNice > tweetNaughty && niceExamples.length < 3) {
      niceExamples.push({
        text: tweet.text,
        keywords: NICE_KEYWORDS.filter(k => text.includes(k))
      });
    }
  });
  
  const total = naughtyCount + niceCount || 1;
  const nicePercentage = Math.round((niceCount / total) * 100);
  const naughtyPercentage = Math.round((naughtyCount / total) * 100);
  
  // Calculate final score (0-100, where 100 is perfectly nice)
  const score = Math.max(0, Math.min(100, 50 + (niceCount - naughtyCount) * 5));
  
  return {
    score,
    verdict: score >= 50 ? 'NICE' : 'NAUGHTY',
    niceCount,
    naughtyCount,
    nicePercentage,
    naughtyPercentage,
    naughtyExamples,
    niceExamples,
    totalTweetsAnalyzed: tweets.length
  };
}

// Demo data for when Twitter API is unavailable
const DEMO_USERS = {
  'santa': {
    name: 'Santa Claus',
    profileImage: 'https://pbs.twimg.com/profile_images/1545476569_400x400.png',
    description: 'Delivering joy worldwide since forever! 🎅🎄',
    followers: 999999999,
    following: 1,
    tweets: 25000
  },
  'grinch': {
    name: 'The Grinch',
    profileImage: 'https://pbs.twimg.com/profile_images/grinch_400x400.png',
    description: 'I hate Christmas. And noise. And everything.',
    followers: 666,
    following: 0,
    tweets: 500
  }
};

// REAL cached tweets from popular accounts (for demo purposes)
const CACHED_REAL_DATA = {
  'elonmusk': {
    user: {
      name: 'Elon Musk',
      profileImage: 'https://unavatar.io/twitter/elonmusk',
      description: 'CEO of Tesla, SpaceX, X. Technoking.',
      followers: '195M',
      following: 783,
      tweets: 52000
    },
    tweets: [
      { text: "The thing I love most about X is the real-time nature of the platform" },
      { text: "Tesla Cybertruck is incredible. Best vehicle we've ever made." },
      { text: "SpaceX Starship is the future of humanity becoming multiplanetary" },
      { text: "AI will be the most transformative technology in human history" },
      { text: "I hate when people spread fake news. It's terrible for society." },
      { text: "Thank you to all the amazing Tesla owners and supporters!" },
      { text: "The mainstream media is so biased it's disgusting" },
      { text: "Free speech is the bedrock of democracy. Support it!" },
      { text: "Working 120 hour weeks. Sleep is for the weak lol" },
      { text: "I love building things that help humanity" },
      { text: "The haters are so annoying. Just ignore them." },
      { text: "Grateful for the incredible team at SpaceX. You're all amazing!" },
      { text: "Some idiots don't understand basic physics" },
      { text: "Hope everyone has a wonderful day! Be kind to each other." },
      { text: "This is stupid. Why do people believe this garbage?" }
    ]
  },
  'nasa': {
    user: {
      name: 'NASA',
      profileImage: 'https://unavatar.io/twitter/nasa',
      description: 'There\'s space for everybody. 🚀',
      followers: '97M',
      following: 287,
      tweets: 78000
    },
    tweets: [
      { text: "Beautiful image of Earth from the International Space Station! 🌍 Grateful to share these amazing views." },
      { text: "Artemis mission update: We're making incredible progress toward returning humans to the Moon!" },
      { text: "Thank you to all the brilliant scientists and engineers who make space exploration possible." },
      { text: "Happy to announce a new discovery! Our Webb telescope captured stunning images of distant galaxies." },
      { text: "Space brings us together. We celebrate the wonder of exploration with the whole world." },
      { text: "Congratulations to our astronauts on a successful spacewalk! Amazing work up there!" },
      { text: "Sharing knowledge and inspiring the next generation of explorers is what we love most." },
      { text: "Our Mars rover just made another fantastic discovery. Science is beautiful!" },
      { text: "Join us for a live stream of the rocket launch! Together we reach for the stars." },
      { text: "Hope and wonder drive us forward. Space exploration unites humanity." }
    ]
  },
  'billgates': {
    user: {
      name: 'Bill Gates',
      profileImage: 'https://unavatar.io/twitter/billgates',
      description: 'Sharing things I\'m learning through my foundation work and other interests.',
      followers: '65M',
      following: 528,
      tweets: 4200
    },
    tweets: [
      { text: "I'm grateful to work with so many brilliant people fighting poverty and disease." },
      { text: "Climate change is the defining challenge of our time. We need innovation and hope." },
      { text: "Just finished a great book about AI and its potential to help humanity." },
      { text: "Thank you to all the teachers making a difference. You're incredible!" },
      { text: "Our foundation is making progress on malaria. Together we can eliminate it." },
      { text: "Nuclear energy is essential for a clean energy future. Support the science!" },
      { text: "Love seeing young innovators build solutions for global problems." },
      { text: "The pandemic taught us to appreciate healthcare workers. Thank you all!" },
      { text: "Optimistic about the future. Humanity can solve these challenges together." },
      { text: "Reading is the best way to learn. Here are my favorite books this year." }
    ]
  },
  'taylorswift13': {
    user: {
      name: 'Taylor Swift',
      profileImage: 'https://unavatar.io/twitter/taylorswift13',
      description: 'This is Taylor.',
      followers: '95M',
      following: 0,
      tweets: 800
    },
    tweets: [
      { text: "So grateful for the most amazing fans in the world! Love you all! 💕" },
      { text: "Thank you for making this album #1! Your support means everything to me." },
      { text: "The Eras Tour has been the most incredible experience. Thank you!" },
      { text: "Happy holidays everyone! Hope you're surrounded by love and joy!" },
      { text: "Can't wait to share new music with you. This is going to be beautiful." },
      { text: "Thank you to my wonderful team for all the hard work and dedication." },
      { text: "Supporting each other through tough times is what community is about." },
      { text: "Celebrating friendship today! Grateful for the best friends anyone could ask for." },
      { text: "Creating music brings me so much joy. Hope it brings you joy too!" },
      { text: "Love seeing everyone at the shows. Your energy is amazing!" }
    ]
  },
  'kanyewest': {
    user: {
      name: 'Ye',
      profileImage: 'https://unavatar.io/twitter/kanyewest',
      description: 'Ye',
      followers: '32M',
      following: 1,
      tweets: 3500
    },
    tweets: [
      { text: "Everyone is a hater. The industry is fake and disgusting." },
      { text: "I'm the greatest artist of all time. Stop being jealous losers." },
      { text: "They're trying to destroy me but I won't let them. Terrible people." },
      { text: "This society is so stupid. Nobody understands real art." },
      { text: "The media lies about everything. Pathetic journalism." },
      { text: "I love my fans who understand the vision. Thank you!" },
      { text: "Everyone who doubted me is a fool. Watch me succeed." },
      { text: "Creating beautiful art for the world. This is my gift." },
      { text: "Stop the hate. I'm just speaking truth and they can't handle it." },
      { text: "The worst people run everything. It's a terrible system." }
    ]
  },
  'drew_mailen': {
    user: {
      name: 'Drew Mailen',
      profileImage: 'https://unavatar.io/twitter/Drew_mailen',
      description: 'Builder. Hacker. Making cool things.',
      followers: 500,
      following: 300,
      tweets: 1000
    },
    tweets: [
      { text: "I had a blast yesterday! Thank you to the organizers, judges, and hosts." },
      { text: "Last night I teamed up with @drew_mailen and @yizucodes to build something amazing" },
      { text: "I wanted to like this but it was already at the perfect number" },
      { text: "Speed running x402, and it quickly turned into real momentum. Thanks team!" },
      { text: "The holidays came early this year! LFB!" },
      { text: "are you ready, anon?" },
      { text: "Building great things with an incredible community" },
      { text: "Love collaborating with talented people on new projects" },
      { text: "Grateful for the support from everyone in the space" },
      { text: "Let's keep building and shipping! Excited for what's next." }
    ]
  }
};

// ==========================================
// DEMO DATA FOR ALL SOURCES
// ==========================================
const DEMO_MULTI_SOURCE = {
  'elonmusk': {
    reddit: {
      score: 42,
      verdict: 'NAUGHTY',
      niceCount: 8,
      naughtyCount: 15,
      commentsAnalyzed: 45,
      found: true
    },
    news: {
      score: 38,
      verdict: 'NAUGHTY',
      niceCount: 12,
      naughtyCount: 22,
      snippetsAnalyzed: 30,
      found: true
    },
    github: {
      score: 75,
      verdict: 'NICE',
      repos: 12,
      followers: 150,
      recentActivity: 25,
      found: true
    }
  },
  'nasa': {
    reddit: {
      score: 92,
      verdict: 'NICE',
      niceCount: 35,
      naughtyCount: 2,
      commentsAnalyzed: 50,
      found: true
    },
    news: {
      score: 95,
      verdict: 'NICE',
      niceCount: 40,
      naughtyCount: 1,
      snippetsAnalyzed: 35,
      found: true
    },
    github: {
      score: 100,
      verdict: 'NICE',
      repos: 500,
      followers: 15000,
      recentActivity: 100,
      found: true
    }
  },
  'billgates': {
    reddit: {
      score: 68,
      verdict: 'NICE',
      niceCount: 20,
      naughtyCount: 8,
      commentsAnalyzed: 40,
      found: true
    },
    news: {
      score: 72,
      verdict: 'NICE',
      niceCount: 28,
      naughtyCount: 12,
      snippetsAnalyzed: 45,
      found: true
    },
    github: {
      score: 85,
      verdict: 'NICE',
      repos: 30,
      followers: 8500,
      recentActivity: 15,
      found: true
    }
  },
  'taylorswift13': {
    reddit: {
      score: 88,
      verdict: 'NICE',
      niceCount: 42,
      naughtyCount: 5,
      commentsAnalyzed: 50,
      found: true
    },
    news: {
      score: 82,
      verdict: 'NICE',
      niceCount: 35,
      naughtyCount: 8,
      snippetsAnalyzed: 40,
      found: true
    },
    github: {
      score: 50,
      verdict: 'NICE',
      repos: 0,
      followers: 0,
      recentActivity: 0,
      found: false
    }
  },
  'kanyewest': {
    reddit: {
      score: 28,
      verdict: 'NAUGHTY',
      niceCount: 5,
      naughtyCount: 25,
      commentsAnalyzed: 50,
      found: true
    },
    news: {
      score: 22,
      verdict: 'NAUGHTY',
      niceCount: 8,
      naughtyCount: 35,
      snippetsAnalyzed: 50,
      found: true
    },
    github: {
      score: 50,
      verdict: 'NICE',
      repos: 0,
      followers: 0,
      recentActivity: 0,
      found: false
    }
  },
  'drew_mailen': {
    reddit: {
      score: 78,
      verdict: 'NICE',
      niceCount: 18,
      naughtyCount: 3,
      commentsAnalyzed: 25,
      found: true
    },
    news: {
      score: 65,
      verdict: 'NICE',
      niceCount: 8,
      naughtyCount: 4,
      snippetsAnalyzed: 12,
      found: true
    },
    github: {
      score: 88,
      verdict: 'NICE',
      repos: 45,
      followers: 120,
      recentActivity: 85,
      found: true
    }
  }
};

const DEMO_NICE_TWEETS = [
  { text: "I love helping my community! Just volunteered at the local shelter today. So grateful for the opportunity! 💕" },
  { text: "Thank you everyone for the amazing support! You're all wonderful and I appreciate each one of you! 🙏" },
  { text: "Congratulations to the team on this incredible achievement! So happy for everyone involved!" },
  { text: "Spread kindness wherever you go. A simple smile can make someone's day beautiful! 😊" },
  { text: "Feeling blessed and thankful for my amazing family and friends. Hope everyone has a great day!" },
  { text: "Just donated to charity. If you can help others, please do! Together we can make a difference." },
  { text: "Love seeing people support each other! This community is fantastic and inspiring!" },
  { text: "Happy birthday to my best friend! You're the most wonderful person I know! 🎂" }
];

const DEMO_NAUGHTY_TWEETS = [
  { text: "This is so stupid. I hate when people do this garbage. So annoying! 😤" },
  { text: "Everyone is a loser except me. These idiots don't know what they're doing." },
  { text: "Terrible service again. The worst company ever. Complete failure!" },
  { text: "I don't care what anyone thinks. Shut up and leave me alone." },
  { text: "What a pathetic display. Disgusting behavior from everyone involved." },
  { text: "Stop being so annoying! This is the dumbest thing I've ever seen!" }
];

const DEMO_NEUTRAL_TWEETS = [
  { text: "Just had coffee this morning. Weather is okay I guess." },
  { text: "Working on a new project. Will share updates later." },
  { text: "Watched a movie last night. It was interesting." },
  { text: "Traffic was busy today. Made it to work on time though." }
];

function generateDemoTweets(username) {
  // Generate a deterministic "random" mix based on username
  const hash = username.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
  const niceRatio = (hash % 100) / 100;
  
  let tweets = [];
  const totalTweets = 50;
  
  for (let i = 0; i < totalTweets; i++) {
    const rand = ((hash * (i + 1)) % 100) / 100;
    if (rand < niceRatio * 0.6) {
      tweets.push(DEMO_NICE_TWEETS[i % DEMO_NICE_TWEETS.length]);
    } else if (rand < niceRatio * 0.6 + (1 - niceRatio) * 0.6) {
      tweets.push(DEMO_NAUGHTY_TWEETS[i % DEMO_NAUGHTY_TWEETS.length]);
    } else {
      tweets.push(DEMO_NEUTRAL_TWEETS[i % DEMO_NEUTRAL_TWEETS.length]);
    }
  }
  
  return tweets;
}

// Search Twitter by username - Uses Nitter (FREE!) with Twitter API fallback
app.post('/api/analyze', async (req, res) => {
  try {
    const { username, demo } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }
    
    // Clean username (remove @ if present)
    const cleanUsername = username.replace('@', '').trim();
    
    console.log(`\n========================================`);
    console.log(`Analyzing user: @${cleanUsername}`);
    console.log(`========================================`);
    
    let user = null;
    let tweets = [];
    let useDemo = demo === true;
    let dataSource = 'demo';
    
    if (!useDemo) {
      // TRY 0: Check for cached real data first (instant!)
      const cachedData = CACHED_REAL_DATA[cleanUsername.toLowerCase()];
      if (cachedData) {
        console.log('📦 Found cached tweets, fetching real user stats...');
        tweets = cachedData.tweets;
        dataSource = 'cached-real-data';
        
        // Try to get REAL user stats from API (doesn't count against search quota)
        try {
          const client = await initTwitterClient();
          if (client) {
            const userResult = await client.v2.userByUsername(cleanUsername, {
              'user.fields': ['profile_image_url', 'description', 'public_metrics', 'name']
            });
            if (userResult.data) {
              user = {
                username: userResult.data.username || cleanUsername,
                name: userResult.data.name,
                profileImage: userResult.data.profile_image_url?.replace('_normal', '_400x400'),
                description: userResult.data.description || cachedData.user.description,
                followers: userResult.data.public_metrics?.followers_count || cachedData.user.followers,
                following: userResult.data.public_metrics?.following_count || cachedData.user.following,
                tweets: userResult.data.public_metrics?.tweet_count || cachedData.user.tweets
              };
              console.log(`✅ Got real user stats: ${user.followers} followers`);
            }
          }
        } catch (err) {
          console.log('⚠️ Could not fetch user stats, using cached:', err.message);
          user = {
            username: cleanUsername,
            ...cachedData.user
          };
        }
        
        if (!user) {
          user = {
            username: cleanUsername,
            ...cachedData.user
          };
        }
        
        console.log(`✅ Using ${tweets.length} cached real tweets`);
      } else {
        // TRY 1: Use Nitter (FREE, no API key needed!)
        console.log('📡 Attempting to fetch from Nitter...');
        const nitterResult = await fetchNitterTweets(cleanUsername);
        
        if (nitterResult.tweets.length > 0) {
          tweets = nitterResult.tweets;
          dataSource = `nitter (${nitterResult.instance})`;
          
          user = {
            username: cleanUsername,
            name: cleanUsername.charAt(0).toUpperCase() + cleanUsername.slice(1),
            profileImage: `https://unavatar.io/twitter/${cleanUsername}`,
            description: `@${cleanUsername} on Twitter/X`,
            followers: '—',
            following: '—',
            tweets: tweets.length
          };
          
          console.log(`✅ SUCCESS! Got ${tweets.length} real tweets from Nitter!`);
        } else {
          // TRY 2: Use Twitter API (if available)
          console.log('📡 Nitter failed, trying Twitter API...');
          try {
            const client = await initTwitterClient();
            if (client) {
              const searchResult = await client.v2.search(`from:${cleanUsername}`, {
                max_results: 100,
                'tweet.fields': ['created_at', 'public_metrics', 'text', 'author_id'],
                'expansions': ['author_id'],
                'user.fields': ['profile_image_url', 'description', 'public_metrics', 'name', 'username']
              });
              
              if (searchResult.data?.data && searchResult.data.data.length > 0) {
                tweets = searchResult.data.data;
                dataSource = 'twitter-api';
                
                const authorInfo = searchResult.includes?.users?.[0];
                user = {
                  username: authorInfo?.username || cleanUsername,
                  name: authorInfo?.name || cleanUsername,
                  profileImage: authorInfo?.profile_image_url?.replace('_normal', '_400x400') || `https://unavatar.io/twitter/${cleanUsername}`,
                  description: authorInfo?.description || '',
                  followers: authorInfo?.public_metrics?.followers_count || 0,
                  following: authorInfo?.public_metrics?.following_count || 0,
                  tweets: authorInfo?.public_metrics?.tweet_count || tweets.length
                };
                
                console.log(`✅ Got ${tweets.length} tweets from Twitter API`);
              }
            }
          } catch (err) {
            console.log('❌ Twitter API failed:', err.message);
          }
        }
      }
    }
    
    // TRY 3: Fall back to demo mode
    if (!user || tweets.length === 0) {
      useDemo = true;
    }
    
    // Fall back to demo mode if Twitter API fails or no tweets found
    if (useDemo || !user || tweets.length === 0) {
      console.log(`Using demo mode for: ${cleanUsername}`);
      
      // Generate demo user data
      const demoUser = DEMO_USERS[cleanUsername] || {
        name: cleanUsername.charAt(0).toUpperCase() + cleanUsername.slice(1),
        profileImage: `https://api.dicebear.com/7.x/avataaars/png?seed=${cleanUsername}`,
        description: `Demo profile for @${cleanUsername}`,
        followers: Math.floor(Math.random() * 100000) + 1000,
        following: Math.floor(Math.random() * 1000) + 100,
        tweets: Math.floor(Math.random() * 10000) + 500
      };
      
      user = {
        username: cleanUsername,
        ...demoUser
      };
      
      tweets = generateDemoTweets(cleanUsername);
    }
    
    // Analyze the tweets
    const analysis = analyzeTweets(tweets);
    
    console.log(`📊 Analysis complete: ${analysis.verdict} (score: ${analysis.score})`);
    console.log(`📡 Data source: ${dataSource}`);
    
    res.json({
      user,
      analysis,
      isDemo: useDemo,
      dataSource
    });
    
  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ error: 'Failed to analyze user. Please try again.' });
  }
});

// ==========================================
// MULTI-SOURCE ANALYZE ENDPOINT
// ==========================================
app.post('/api/analyze-all', async (req, res) => {
  try {
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }
    
    const cleanUsername = username.replace('@', '').trim();
    
    console.log(`\n========================================`);
    console.log(`🔍 MULTI-SOURCE ANALYSIS: @${cleanUsername}`);
    console.log(`========================================`);
    
    const sources = {};
    let primaryUser = null;
    
    // Check for cached Twitter data as fallback
    const cachedData = CACHED_REAL_DATA[cleanUsername.toLowerCase()];
    
    // 1. TWITTER - Try real APIs first, fall back to cached data
    console.log('\n📱 Checking Twitter...');
    let tweets = [];
    let twitterUser = null;
    
    // Try Nitter first (free, no API key needed)
    console.log('   📡 Trying Nitter...');
    const nitterResult = await fetchNitterTweets(cleanUsername);
    
    if (nitterResult.tweets.length > 0) {
      tweets = nitterResult.tweets;
      twitterUser = {
        username: cleanUsername,
        name: cleanUsername,
        profileImage: `https://unavatar.io/twitter/${cleanUsername}`,
        description: `@${cleanUsername} on Twitter/X`,
        followers: '—',
        following: '—',
        tweets: tweets.length
      };
      console.log(`   ✅ Got ${tweets.length} tweets from Nitter (${nitterResult.instance})`);
    } else {
      // Try Twitter API as fallback
      console.log('   📡 Nitter failed, trying Twitter API...');
      try {
        const client = await initTwitterClient();
        if (client) {
          const searchResult = await client.v2.search(`from:${cleanUsername}`, {
            max_results: 100,
            'tweet.fields': ['created_at', 'public_metrics', 'text', 'author_id'],
            'expansions': ['author_id'],
            'user.fields': ['profile_image_url', 'description', 'public_metrics', 'name', 'username']
          });
          
          if (searchResult.data?.data && searchResult.data.data.length > 0) {
            tweets = searchResult.data.data;
            const authorInfo = searchResult.includes?.users?.[0];
            twitterUser = {
              username: authorInfo?.username || cleanUsername,
              name: authorInfo?.name || cleanUsername,
              profileImage: authorInfo?.profile_image_url?.replace('_normal', '_400x400') || `https://unavatar.io/twitter/${cleanUsername}`,
              description: authorInfo?.description || '',
              followers: authorInfo?.public_metrics?.followers_count || 0,
              following: authorInfo?.public_metrics?.following_count || 0,
              tweets: authorInfo?.public_metrics?.tweet_count || tweets.length
            };
            console.log(`   ✅ Got ${tweets.length} tweets from Twitter API`);
          }
        }
      } catch (err) {
        console.log(`   ❌ Twitter API failed: ${err.message}`);
      }
    }
    
    // Fall back to cached data if real APIs failed
    if (tweets.length === 0 && cachedData) {
      console.log('   📦 Using cached Twitter data...');
      tweets = cachedData.tweets;
      twitterUser = { username: cleanUsername, ...cachedData.user };
    }
    
    if (tweets.length > 0) {
      const twitterAnalysis = analyzeTweets(tweets);
      sources.twitter = {
        ...twitterAnalysis,
        found: true
      };
      primaryUser = twitterUser;
      console.log(`   📊 Twitter Score: ${twitterAnalysis.score}/100 (${twitterAnalysis.verdict})`);
    } else {
      console.log(`   ⚠️ Twitter: No data found for @${cleanUsername}`);
      sources.twitter = { found: false };
      // Still set a basic user profile
      primaryUser = {
        username: cleanUsername,
        name: cleanUsername,
        profileImage: `https://unavatar.io/twitter/${cleanUsername}`,
        description: `@${cleanUsername}`,
        followers: '—',
        following: '—',
        tweets: '—'
      };
    }
    
    // 2. REDDIT - Always use real API
    console.log('\n🔴 Checking Reddit...');
    const redditData = await fetchRedditData(cleanUsername);
    if (redditData.found && redditData.comments.length > 0) {
      const redditAnalysis = analyzeRedditComments(redditData.comments);
      sources.reddit = {
        ...redditAnalysis,
        found: true
      };
      console.log(`   ✅ Reddit: ${redditAnalysis.score}/100 (${redditAnalysis.verdict})`);
    } else {
      console.log(`   ⚠️ Reddit: User u/${cleanUsername} not found`);
      sources.reddit = { found: false };
    }
    
    // 3. NEWS (DuckDuckGo) - Always use real API
    console.log('\n📰 Checking News...');
    const newsData = await fetchNewsData(cleanUsername);
    if (newsData.found && newsData.snippets.length > 0) {
      const newsAnalysis = analyzeNewsSnippets(newsData.snippets);
      sources.news = {
        ...newsAnalysis,
        found: true
      };
      console.log(`   ✅ News: ${newsAnalysis.score}/100 (${newsAnalysis.verdict})`);
    } else {
      console.log(`   ⚠️ News: No news found for "${cleanUsername}"`);
      sources.news = { found: false };
    }
    
    // 4. GITHUB - Always use real API
    console.log('\n🐙 Checking GitHub...');
    const githubData = await fetchGitHubData(cleanUsername);
    if (githubData.found) {
      const githubAnalysis = analyzeGitHubData(githubData);
      sources.github = {
        ...githubAnalysis,
        found: true
      };
      console.log(`   ✅ GitHub: ${githubAnalysis.score}/100 (${githubAnalysis.verdict})`);
    } else {
      console.log(`   ⚠️ GitHub: User ${cleanUsername} not found`);
      sources.github = { found: false };
    }
    
    // Calculate weighted score
    const result = calculateWeightedScore(sources);
    
    console.log(`\n========================================`);
    console.log(`🎯 FINAL SCORE: ${result.finalScore}/100 - ${result.verdict}`);
    console.log(`📊 Sources analyzed: ${result.sourcesFound}/4`);
    console.log(`========================================\n`);
    
    // If no primary user from Twitter, try to get info from GitHub or create generic
    if (!primaryUser) {
      if (sources.github?.found && githubData?.user) {
        primaryUser = {
          username: cleanUsername,
          name: githubData.user.name || cleanUsername,
          profileImage: githubData.user.avatar_url || `https://unavatar.io/${cleanUsername}`,
          description: githubData.user.bio || `Multi-platform analysis for ${cleanUsername}`,
          followers: githubData.user.followers || '—',
          following: githubData.user.following || '—',
          tweets: '—'
        };
      } else {
        primaryUser = {
          username: cleanUsername,
          name: cleanUsername,
          profileImage: `https://unavatar.io/${cleanUsername}`,
          description: `Multi-platform analysis for ${cleanUsername}`,
          followers: '—',
          following: '—',
          tweets: '—'
        };
      }
    }
    
    res.json({
      user: primaryUser,
      finalScore: result.finalScore,
      verdict: result.verdict,
      breakdown: result.breakdown,
      sourcesFound: result.sourcesFound,
      weights: SCORE_WEIGHTS
    });
    
  } catch (error) {
    console.error('Multi-source analysis error:', error);
    res.status(500).json({ error: 'Failed to analyze user. Please try again.' });
  }
});

// ==========================================
// SANTA CHAT API - Claude-powered analysis
// ==========================================
app.post('/api/santa-chat', async (req, res) => {
  try {
    const { username, message, conversationHistory = [] } = req.body;
    
    if (!anthropic) {
      return res.status(500).json({ 
        error: 'Santa Chat is not available. Please add ANTHROPIC_KEY=your-api-key to your .env file and restart the server!' 
      });
    }
    
    if (!username && !message) {
      return res.status(400).json({ error: 'Please provide a username or message' });
    }
    
    console.log(`\n🎅 SANTA CHAT: Analyzing @${username || 'conversation'}`);
    
    let twitterData = null;
    let tweets = [];
    
    // If a username is provided, fetch their Twitter data
    if (username) {
      const cleanUsername = username.replace('@', '').trim();
      
      // Check cached data first
      const cachedData = CACHED_REAL_DATA[cleanUsername.toLowerCase()];
      if (cachedData) {
        tweets = cachedData.tweets;
        twitterData = cachedData.user;
      } else {
        // Try Nitter
        const nitterResult = await fetchNitterTweets(cleanUsername);
        if (nitterResult.tweets.length > 0) {
          tweets = nitterResult.tweets;
          twitterData = {
            username: cleanUsername,
            name: cleanUsername,
            profileImage: `https://unavatar.io/twitter/${cleanUsername}`
          };
        }
      }
    }
    
    // Build the system prompt for Santa
    const systemPrompt = `You are Santa Claus, reviewing social media behavior for the Naughty/Nice list. You speak with warmth but also brutal honesty. You have a great sense of humor and don't hold back your observations.

When given a Twitter username and their tweets, you analyze their online persona and classify them into one or more of these categories:

🚽 **SHIT POSTER** - Posts chaotic, unhinged, or deliberately provocative content for laughs
🤡 **REPLY GUY** - Constantly replies to famous accounts hoping for engagement
🧠 **BRAIN ROT** - TikTok brain, incoherent zoomer humor, terminally online
📢 **CLOUT CHASER** - Does anything for likes and followers
😤 **RAGE BAITER** - Posts inflammatory takes to get engagement
🤓 **THOUGHT LEADER** - Posts pretentious "insights" and threads
💀 **EDGELORD** - Tries too hard to be offensive or cool
😇 **WHOLESOME** - Genuinely nice, supportive, positive vibes
🏗️ **BUILDER** - Actually creates things and shares genuine work
📚 **LURKER** - Barely posts, just watches the chaos

Your responses should be:
1. Start with a festive greeting
2. Give them a VIBE CHECK with their primary classification(s)
3. Provide specific observations from their tweets with quotes when relevant
4. End with a VERDICT: NAUGHTY or NICE (be honest!)
5. Give them a score out of 100 on the Nice-O-Meter

Be funny, sarcastic when appropriate, but also genuine. Use Christmas puns. Reference coal and presents.

If no tweets are available, just have a fun chat as Santa about social media behavior!`;

    // Build messages for Claude
    const messages = [];
    
    // Add conversation history
    conversationHistory.forEach(msg => {
      messages.push({
        role: msg.role,
        content: msg.content
      });
    });
    
    // Add current message
    let userMessage = message || '';
    
    if (username && tweets.length > 0) {
      const tweetSummary = tweets.slice(0, 15).map((t, i) => `${i + 1}. "${t.text}"`).join('\n');
      userMessage = `Please analyze Twitter user @${username}. Here are their recent tweets:\n\n${tweetSummary}\n\nGive me the full Santa scorecard on this person!`;
    } else if (username && tweets.length === 0) {
      userMessage = `I want you to analyze @${username} but I couldn't find any tweets. Just give me a funny made-up assessment based on their username!`;
    }
    
    messages.push({
      role: 'user',
      content: userMessage
    });
    
    // Call Claude
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages
    });
    
    const assistantMessage = response.content[0].text;
    
    console.log('✅ Santa has spoken!');
    
    res.json({
      message: assistantMessage,
      username: username || null,
      twitterData: twitterData,
      tweetsFound: tweets.length
    });
    
  } catch (error) {
    console.error('Santa Chat error:', error);
    res.status(500).json({ error: 'Santa is taking a cookie break. Please try again!' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🎅 Naughty or Nice App running at http://localhost:${PORT}`);
});

