interface ResourceItem {
  resourceId: string;
  didId: string;
  resourceType: string;
  resourceName: string;
  operationType: string;
  feePayer: string;
  amount: number;
  denom: string;
  blockHeight: string;
  transactionHash: string;
  createdAt: string;
  success: boolean;
}

interface ApiResponse {
  items: ResourceItem[];
  totalCount: number;
  page: number;
  totalPages: number;
}

interface ResourceStats {
  size: number;
  contentType: string;
  success: boolean;
  error?: string;
  feePayer?: string;
  url?: string;
}

interface ContentTypeStats {
  count: number;
  totalSize: number;
  sizes: number[];
  sizeDistribution: Record<string, number>;
  largestResources: Array<{ size: number; feePayer: string; url: string }>;
}

const SIZE_BUCKETS = [
  { name: '0-1KB', max: 1024 },
  { name: '1-5KB', max: 5 * 1024 },
  { name: '5-10KB', max: 10 * 1024 },
  { name: '10-15KB', max: 15 * 1024 },
  { name: '15-20KB', max: 20 * 1024 },
  { name: '20-25KB', max: 25 * 1024 },
  { name: '25-30KB', max: 30 * 1024 },
  { name: '30-35KB', max: 35 * 1024 },
  { name: '35-40KB', max: 40 * 1024 },
  { name: '40-45KB', max: 45 * 1024 },
  { name: '45-50KB', max: 50 * 1024 },
  { name: '50-100KB', max: 100 * 1024 },
  { name: '100KB+', max: Infinity }
];

const TOP_RESOURCES_COUNT = 32;

function getSizeBucket(size: number): string {
  return SIZE_BUCKETS.find(bucket => size <= bucket.max)?.name || 'Unknown';
}

async function fetchPage(page: number): Promise<ApiResponse> {
  const response = await fetch(
    `https://data-api.cheqd.io/analytics/mainnet/resource?startDate=2020-01-01&page=${page}`
  );
  return response.json();
}

async function getResourceStats(resourceUrl: string, feePayer: string, retries = 3): Promise<ResourceStats> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(resourceUrl);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const contentType = response.headers.get('content-type') || 'unknown';
      const content = await response.text();
      
      return {
        size: content.length,
        contentType,
        success: true,
        feePayer,
        url: resourceUrl
      };
    } catch (error) {
      if (attempt === retries) {
        return {
          size: 0,
          contentType: 'error',
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          feePayer,
          url: resourceUrl
        };
      }
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
  return {
    size: 0,
    contentType: 'error',
    success: false,
    error: 'Max retries reached',
    feePayer,
    url: resourceUrl
  };
}

function calculateMedian(sizes: number[]): number {
  if (sizes.length === 0) return 0;
  const sorted = [...sizes].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function calculatePercentiles(sizes: number[]): Record<number, number> {
  if (sizes.length === 0) return {};
  
  const sorted = [...sizes].sort((a, b) => a - b);
  const percentiles = [10, 25, 50, 75, 90, 95, 99];
  const result: Record<number, number> = {};
  
  for (const p of percentiles) {
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    result[p] = sorted[index];
  }
  
  return result;
}

async function getResourceSizes() {
  try {
    // Get first page to determine total pages
    const firstPage = await fetchPage(1);
    const totalPages = firstPage.totalPages;
    const resourceStats: ResourceStats[] = [];
    const contentTypeStats: Record<string, ContentTypeStats> = {};

    console.log(`Total pages to process: ${totalPages}`);

    // Process all pages
    for (let page = 1; page <= totalPages; page++) {
      console.log(`Processing page ${page}/${totalPages}`);
      
      const data = page === 1 ? firstPage : await fetchPage(page);

      // Process each resource in the current page
      for (const item of data.items) {
        const resourceUrl = `https://resolver.cheqd.net/1.0/identifiers/${item.didId}/resources/${item.resourceId}`;
        console.log(`Processing resource: ${item.resourceId}`);
        
        const stats = await getResourceStats(resourceUrl, item.feePayer);
        resourceStats.push(stats);

        // Update contentType stats
        if (stats.success) {
          if (!contentTypeStats[stats.contentType]) {
            contentTypeStats[stats.contentType] = {
              count: 0,
              totalSize: 0,
              sizes: [],
              sizeDistribution: {},
              largestResources: []
            };
          }
          contentTypeStats[stats.contentType].count++;
          contentTypeStats[stats.contentType].totalSize += stats.size;
          contentTypeStats[stats.contentType].sizes.push(stats.size);
          
          // Update size distribution
          const bucket = getSizeBucket(stats.size);
          contentTypeStats[stats.contentType].sizeDistribution[bucket] = 
            (contentTypeStats[stats.contentType].sizeDistribution[bucket] || 0) + 1;
          
          // Update largest resources
          contentTypeStats[stats.contentType].largestResources.push({
            size: stats.size,
            feePayer: stats.feePayer || 'unknown',
            url: stats.url || 'unknown'
          });
          
          // Keep only top N largest
          contentTypeStats[stats.contentType].largestResources.sort((a, b) => b.size - a.size);
          if (contentTypeStats[stats.contentType].largestResources.length > TOP_RESOURCES_COUNT) {
            contentTypeStats[stats.contentType].largestResources.pop();
          }
        }
      }
    }

    // Calculate statistics
    const successfulStats = resourceStats.filter(s => s.success);
    const failedStats = resourceStats.filter(s => !s.success);

    if (successfulStats.length > 0) {
      // Calculate average
      const average = successfulStats.reduce((sum, s) => sum + s.size, 0) / successfulStats.length;

      // Calculate median
      const sortedSizes = [...successfulStats].sort((a, b) => a.size - b.size);
      const middle = Math.floor(sortedSizes.length / 2);
      const median = sortedSizes.length % 2 === 0
        ? (sortedSizes[middle - 1].size + sortedSizes[middle].size) / 2
        : sortedSizes[middle].size;

      console.log('\nStatistics:');
      console.log(`Total resources found: ${resourceStats.length}`);
      console.log(`Successfully analyzed: ${successfulStats.length}`);
      console.log(`Failed to analyze: ${failedStats.length}`);
      
      if (failedStats.length > 0) {
        console.log('\nFailure reasons:');
        const errorCounts = failedStats.reduce((acc, s) => {
          acc[s.error || 'Unknown error'] = (acc[s.error || 'Unknown error'] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);
        
        Object.entries(errorCounts).forEach(([error, count]) => {
          console.log(`${error}: ${count}`);
        });
      }

      console.log('\nContent Type Statistics:');
      Object.entries(contentTypeStats).forEach(([type, stats]) => {
        const avgSize = stats.totalSize / stats.count;
        const medianSize = calculateMedian(stats.sizes);
        const maxSize = Math.max(...stats.sizes);
        const percentiles = calculatePercentiles(stats.sizes);
        
        console.log(`\n${type}:`);
        console.log(`  Count: ${stats.count}`);
        console.log(`  Average size: ${(avgSize / 1024).toFixed(2)} KB`);
        console.log(`  Median size: ${(medianSize / 1024).toFixed(2)} KB`);
        console.log(`  Max size: ${(maxSize / 1024).toFixed(2)} KB`);
        console.log(`  Total size: ${(stats.totalSize / 1024).toFixed(2)} KB`);
        
        console.log('\n  Size Distribution:');
        Object.entries(stats.sizeDistribution)
          .sort(([a], [b]) => {
            const aIndex = SIZE_BUCKETS.findIndex(bucket => bucket.name === a);
            const bIndex = SIZE_BUCKETS.findIndex(bucket => bucket.name === b);
            return aIndex - bIndex;
          })
          .forEach(([bucket, count]) => {
            const percentage = ((count / stats.count) * 100).toFixed(1);
            console.log(`    ${bucket}: ${count} (${percentage}%)`);
          });
        
        console.log('\n  Percentiles:');
        Object.entries(percentiles).forEach(([p, size]) => {
          console.log(`    ${p}th percentile: ${(size / 1024).toFixed(2)} KB`);
        });
        
        console.log(`\n  Top ${TOP_RESOURCES_COUNT} Largest Resources:`);
        stats.largestResources.forEach((resource, index) => {
          console.log(`    ${index + 1}. Size: ${(resource.size / 1024).toFixed(2)} KB`);
          console.log(`       Fee Payer: ${resource.feePayer}`);
          console.log(`       URL: ${resource.url}`);
        });
      });

      console.log('\nOverall Statistics:');
      console.log(`Average size: ${(average / 1024).toFixed(2)} KB`);
      console.log(`Median size: ${(median / 1024).toFixed(2)} KB`);
    } else {
      console.log('No valid resource sizes were collected.');
    }

  } catch (error) {
    console.error('Error:', error);
  }
}

getResourceSizes(); 