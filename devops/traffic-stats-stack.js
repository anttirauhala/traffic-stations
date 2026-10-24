"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrafficStatsStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const lambdaNodejs = __importStar(require("aws-cdk-lib/aws-lambda-nodejs"));
const apigateway = __importStar(require("aws-cdk-lib/aws-apigateway"));
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const sqs = __importStar(require("aws-cdk-lib/aws-sqs"));
const events = __importStar(require("aws-cdk-lib/aws-events"));
const targets = __importStar(require("aws-cdk-lib/aws-events-targets"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const path = __importStar(require("path"));
const eventSources = __importStar(require("aws-cdk-lib/aws-lambda-event-sources"));
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const s3deploy = __importStar(require("aws-cdk-lib/aws-s3-deployment"));
const cloudfront = __importStar(require("aws-cdk-lib/aws-cloudfront"));
const origins = __importStar(require("aws-cdk-lib/aws-cloudfront-origins"));
const DEVELOPMENT_ENV = false;
class TrafficStatsStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // Create DynamoDB table for traffic data
        const trafficDataTable = new dynamodb.Table(this, `TrafficDataTable-${id}`, {
            partitionKey: { name: 'stationId', type: dynamodb.AttributeType.NUMBER },
            sortKey: { name: 'compositeKey', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: DEVELOPMENT_ENV ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
        });
        // Add Global Secondary Index (GSI) for querying by date
        trafficDataTable.addGlobalSecondaryIndex({
            indexName: 'MeasuredTimeIndex',
            partitionKey: { name: 'measuredTime', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'stationId', type: dynamodb.AttributeType.NUMBER },
            projectionType: dynamodb.ProjectionType.ALL,
        });
        // Create SQS queue for traffic data collection
        const trafficDataQueue = new sqs.Queue(this, `TrafficDataQueue-${id}`, {
            visibilityTimeout: cdk.Duration.seconds(300),
            retentionPeriod: cdk.Duration.days(14),
        });
        // Create Lambda function for collecting traffic data
        const collectorLambda = new lambdaNodejs.NodejsFunction(this, `TrafficCollectorLambda-${id}`, {
            runtime: lambda.Runtime.NODEJS_24_X,
            entry: path.join(__dirname, '../traffic-stats/backend/src/lambdas/collector/index.ts'),
            handler: 'handler',
            timeout: cdk.Duration.seconds(60),
            environment: {
                SQS_QUEUE_URL: trafficDataQueue.queueUrl,
            },
            bundling: {
                externalModules: ['aws-sdk'],
            },
        });
        // Allow collector Lambda to send messages to SQS
        trafficDataQueue.grantSendMessages(collectorLambda);
        // Schedule the collector Lambda to run every hour
        const rule = new events.Rule(this, `HourlyRule-${id}`, {
            schedule: events.Schedule.cron({ minute: '5' }),
        });
        rule.addTarget(new targets.LambdaFunction(collectorLambda));
        // Create Lambda function for processing traffic data from SQS
        const processorLambda = new lambdaNodejs.NodejsFunction(this, `TrafficProcessorLambda-${id}`, {
            runtime: lambda.Runtime.NODEJS_24_X,
            entry: path.join(__dirname, '../traffic-stats/backend/src/lambdas/processor/index.ts'),
            handler: 'handler',
            timeout: cdk.Duration.seconds(60),
            environment: {
                DYNAMODB_TABLE_NAME: trafficDataTable.tableName,
            },
            bundling: {
                externalModules: ['aws-sdk'],
            },
        });
        // Allow processor Lambda to write to DynamoDB
        trafficDataTable.grantWriteData(processorLambda);
        // Grant permissions to the processor Lambda to receive messages from SQS
        processorLambda.addToRolePolicy(new iam.PolicyStatement({
            actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
            resources: [trafficDataQueue.queueArn],
        }));
        // Configure SQS as event source for processor Lambda
        processorLambda.addEventSource(new eventSources.SqsEventSource(trafficDataQueue, {
            batchSize: 10,
        }));
        // Create Lambda functions for API endpoints
        const dailyDataLambda = new lambdaNodejs.NodejsFunction(this, `DailyDataLambda-${id}`, {
            runtime: lambda.Runtime.NODEJS_24_X,
            entry: path.join(__dirname, '../traffic-stats/backend/src/lambdas/api/daily-data/index.ts'),
            handler: 'handler',
            timeout: cdk.Duration.seconds(30),
            environment: {
                DYNAMODB_TABLE_NAME: trafficDataTable.tableName,
            },
            bundling: {
                externalModules: ['aws-sdk'],
            },
        });
        const hourlyAverageLambda = new lambdaNodejs.NodejsFunction(this, `HourlyAverageLambda-${id}`, {
            runtime: lambda.Runtime.NODEJS_24_X,
            entry: path.join(__dirname, '../traffic-stats/backend/src/lambdas/api/hourly-average/index.ts'),
            handler: 'handler',
            timeout: cdk.Duration.seconds(30),
            environment: {
                DYNAMODB_TABLE_NAME: trafficDataTable.tableName,
            },
            bundling: {
                externalModules: ['aws-sdk'],
            },
        });
        // Grant read access to DynamoDB for API Lambda functions
        trafficDataTable.grantReadData(dailyDataLambda);
        trafficDataTable.grantReadData(hourlyAverageLambda);
        // Create API Gateway
        const api = new apigateway.RestApi(this, `TrafficDataApi-${id}`, {
            restApiName: 'Traffic Data Service',
            description: 'API for traffic statistics data',
            defaultCorsPreflightOptions: {
                allowOrigins: apigateway.Cors.ALL_ORIGINS,
                allowMethods: apigateway.Cors.ALL_METHODS,
            },
            deployOptions: {
                stageName: 'api',
                throttlingRateLimit: 100, // requests per second
                throttlingBurstLimit: 200, // maximum concurrent requests
            },
        });
        // Create API resources and methods
        const trafficResource = api.root.addResource('traffic');
        const stationResource = trafficResource.addResource('station');
        const stationIdResource = stationResource.addResource('{stationId}');
        // Daily data endpoint
        const dailyResource = stationIdResource.addResource('daily');
        dailyResource.addMethod('GET', new apigateway.LambdaIntegration(dailyDataLambda));
        // Hourly average endpoint
        const hourlyAverageResource = stationIdResource.addResource('hourly-average');
        hourlyAverageResource.addMethod('GET', new apigateway.LambdaIntegration(hourlyAverageLambda));
        // Export the API URL for the frontend
        new cdk.CfnOutput(this, `ApiUrl-${id}`, {
            value: api.url,
            description: 'The URL of the API Gateway',
        });
        // Create S3 bucket for frontend
        const frontendBucket = new s3.Bucket(this, `FrontendBucket-${id}`, {
            websiteIndexDocument: 'index.html',
            publicReadAccess: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ACLS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true
        });
        // Create CloudFront distribution for frontend
        const distribution = new cloudfront.Distribution(this, `FrontendDistribution-${id}`, {
            defaultBehavior: { origin: new origins.S3Origin(frontendBucket) },
        });
        // Deploy frontend to S3 bucket
        new s3deploy.BucketDeployment(this, `DeployFrontend-${id}`, {
            sources: [s3deploy.Source.asset(path.join(__dirname, '../traffic-stats/frontend/dist'))],
            destinationBucket: frontendBucket,
            cacheControl: [s3deploy.CacheControl.maxAge(cdk.Duration.seconds(0))],
            distribution: distribution,
        });
        /*
            // Create a temporary directory for the config file
            const tempDir = path.join(__dirname, '../traffic-stats/frontend/temp');
            if (!fs.existsSync(tempDir)) {
              fs.mkdirSync(tempDir);
            }
        
            // Read the template file
            const configTemplate = fs.readFileSync(path.join(__dirname, '../traffic-stats/frontend/src/config.template'), 'utf8');
        
            // Replace the placeholder with the actual API URL
            const configContent = configTemplate.replace('__API_URL__', `https://${api.restApiId}.execute-api.${cdk.Aws.REGION}.${cdk.Aws.URL_SUFFIX}/${api.deploymentStage.stageName}/`);
        
            // Write the updated content to the temporary directory
            const tempConfigPath = path.join(tempDir, 'config.ts');
            fs.writeFileSync(tempConfigPath, configContent);
        
            // Pass API URL to frontend
            new s3deploy.BucketDeployment(this, `DeployFrontendConfig-${id}`, {
              sources: [s3deploy.Source.asset(tempDir)],
              destinationBucket: frontendBucket,
              destinationKeyPrefix: 'src',
              cacheControl: [s3deploy.CacheControl.noCache()],
            });
        */
        // Output the CloudFront URL
        new cdk.CfnOutput(this, `FrontendUrl-${id}`, {
            value: distribution.distributionDomainName,
            description: 'The URL of the CloudFront distribution for the frontend',
        });
    }
}
exports.TrafficStatsStack = TrafficStatsStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidHJhZmZpYy1zdGF0cy1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInRyYWZmaWMtc3RhdHMtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxpREFBbUM7QUFFbkMsK0RBQWlEO0FBQ2pELDRFQUE4RDtBQUM5RCx1RUFBeUQ7QUFDekQsbUVBQXFEO0FBQ3JELHlEQUEyQztBQUMzQywrREFBaUQ7QUFDakQsd0VBQTBEO0FBQzFELHlEQUEyQztBQUMzQywyQ0FBNkI7QUFDN0IsbUZBQXFFO0FBQ3JFLHVEQUF5QztBQUN6Qyx3RUFBMEQ7QUFDMUQsdUVBQXlEO0FBQ3pELDRFQUE4RDtBQUc5RCxNQUFNLGVBQWUsR0FBRyxLQUFLLENBQUM7QUFFOUIsTUFBYSxpQkFBa0IsU0FBUSxHQUFHLENBQUMsS0FBSztJQUM5QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXNCO1FBQzlELEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLHlDQUF5QztRQUN6QyxNQUFNLGdCQUFnQixHQUFHLElBQUksUUFBUSxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsb0JBQW9CLEVBQUUsRUFBRSxFQUFFO1lBQzFFLFlBQVksRUFBRSxFQUFFLElBQUksRUFBRSxXQUFXLEVBQUUsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTSxFQUFFO1lBQ3hFLE9BQU8sRUFBRSxFQUFFLElBQUksRUFBRSxjQUFjLEVBQUUsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTSxFQUFFO1lBQ3RFLFdBQVcsRUFBRSxRQUFRLENBQUMsV0FBVyxDQUFDLGVBQWU7WUFDakQsYUFBYSxFQUFFLGVBQWUsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxhQUFhLENBQUMsTUFBTTtTQUN0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QyxZQUFZLEVBQUUsQ0FBQyxRQUFRLENBQUMsWUFBWSxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQ3JFLFlBQVksRUFBRSxZQUFZO1NBQzNCLENBQUMsQ0FBQztRQUVIOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7VUF3QkU7UUFDRiw0QkFBNEI7UUFDNUIsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxlQUFlLEVBQUUsRUFBRSxFQUFFO1lBQzNDLEtBQUssRUFBRSxZQUFZLENBQUMsc0JBQXNCO1lBQzFDLFdBQVcsRUFBRSx5REFBeUQ7U0FDdkUsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBbk1ELDhDQW1NQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhJztcbmltcG9ydCAqIGFzIGxhbWJkYU5vZGVqcyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhLW5vZGVqcyc7XG5pbXBvcnQgKiBhcyBhcGlnYXRld2F5IGZyb20gJ2F3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5JztcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gJ2F3cy1jZGstbGliL2F3cy1keW5hbW9kYic7XG5pbXBvcnQgKiBhcyBzcXMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXNxcyc7XG5pbXBvcnQgKiBhcyBldmVudHMgZnJvbSAnYXdzLWNkay1saWIvYXdzLWV2ZW50cyc7XG5pbXBvcnQgKiBhcyB0YXJnZXRzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1ldmVudHMtdGFyZ2V0cyc7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuaW1wb3J0ICogYXMgZXZlbnRTb3VyY2VzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEtZXZlbnQtc291cmNlcyc7XG5pbXBvcnQgKiBhcyBzMyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMnO1xuaW1wb3J0ICogYXMgczNkZXBsb3kgZnJvbSAnYXdzLWNkay1saWIvYXdzLXMzLWRlcGxveW1lbnQnO1xuaW1wb3J0ICogYXMgY2xvdWRmcm9udCBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udCc7XG5pbXBvcnQgKiBhcyBvcmlnaW5zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jbG91ZGZyb250LW9yaWdpbnMnO1xuaW1wb3J0ICogYXMgZnMgZnJvbSAnZnMnO1xuXG5jb25zdCBERVZFTE9QTUVOVF9FTlYgPSBmYWxzZTtcblxuZXhwb3J0IGNsYXNzIFRyYWZmaWNTdGF0c1N0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBjZGsuU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gQ3JlYXRlIER5bmFtb0RCIHRhYmxlIGZvciB0cmFmZmljIGRhdGFcbiAgICBjb25zdCB0cmFmZmljRGF0YVRhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsIGBUcmFmZmljRGF0YVRhYmxlLSR7aWR9YCwge1xuICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6ICdzdGF0aW9uSWQnLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLk5VTUJFUiB9LFxuICAgICAgc29ydEtleTogeyBuYW1lOiAnY29tcG9zaXRlS2V5JywgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICByZW1vdmFsUG9saWN5OiBERVZFTE9QTUVOVF9FTlYgPyBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZIDogY2RrLlJlbW92YWxQb2xpY3kuUkVUQUlOLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIEdsb2JhbCBTZWNvbmRhcnkgSW5kZXggKEdTSSkgZm9yIHF1ZXJ5aW5nIGJ5IGRhdGVcbiAgICB0cmFmZmljRGF0YVRhYmxlLmFkZEdsb2JhbFNlY29uZGFyeUluZGV4KHtcbiAgICAgIGluZGV4TmFtZTogJ01lYXN1cmVkVGltZUluZGV4JyxcbiAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiAnbWVhc3VyZWRUaW1lJywgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHNvcnRLZXk6IHsgbmFtZTogJ3N0YXRpb25JZCcsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuTlVNQkVSIH0sXG4gICAgICBwcm9qZWN0aW9uVHlwZTogZHluYW1vZGIuUHJvamVjdGlvblR5cGUuQUxMLFxuICAgIH0pO1xuXG4gICAgLy8gQ3JlYXRlIFNRUyBxdWV1ZSBmb3IgdHJhZmZpYyBkYXRhIGNvbGxlY3Rpb25cbiAgICBjb25zdCB0cmFmZmljRGF0YVF1ZXVlID0gbmV3IHNxcy5RdWV1ZSh0aGlzLCBgVHJhZmZpY0RhdGFRdWV1ZS0ke2lkfWAsIHtcbiAgICAgIHZpc2liaWxpdHlUaW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMDApLFxuICAgICAgcmV0ZW50aW9uUGVyaW9kOiBjZGsuRHVyYXRpb24uZGF5cygxNCksXG4gICAgfSk7XG5cbiAgICAvLyBDcmVhdGUgTGFtYmRhIGZ1bmN0aW9uIGZvciBjb2xsZWN0aW5nIHRyYWZmaWMgZGF0YVxuICAgIGNvbnN0IGNvbGxlY3RvckxhbWJkYSA9IG5ldyBsYW1iZGFOb2RlanMuTm9kZWpzRnVuY3Rpb24odGhpcywgYFRyYWZmaWNDb2xsZWN0b3JMYW1iZGEtJHtpZH1gLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjRfWCxcbiAgICAgIGVudHJ5OiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vdHJhZmZpYy1zdGF0cy9iYWNrZW5kL3NyYy9sYW1iZGFzL2NvbGxlY3Rvci9pbmRleC50cycpLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNjApLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgU1FTX1FVRVVFX1VSTDogdHJhZmZpY0RhdGFRdWV1ZS5xdWV1ZVVybCxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzoge1xuICAgICAgICBleHRlcm5hbE1vZHVsZXM6IFsnYXdzLXNkayddLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIEFsbG93IGNvbGxlY3RvciBMYW1iZGEgdG8gc2VuZCBtZXNzYWdlcyB0byBTUVNcbiAgICB0cmFmZmljRGF0YVF1ZXVlLmdyYW50U2VuZE1lc3NhZ2VzKGNvbGxlY3RvckxhbWJkYSk7XG5cbiAgICAvLyBTY2hlZHVsZSB0aGUgY29sbGVjdG9yIExhbWJkYSB0byBydW4gZXZlcnkgaG91clxuICAgIGNvbnN0IHJ1bGUgPSBuZXcgZXZlbnRzLlJ1bGUodGhpcywgYEhvdXJseVJ1bGUtJHtpZH1gLCB7XG4gICAgICBzY2hlZHVsZTogZXZlbnRzLlNjaGVkdWxlLmNyb24oeyBtaW51dGU6ICc1JyB9KSxcbiAgICB9KTtcbiAgICBydWxlLmFkZFRhcmdldChuZXcgdGFyZ2V0cy5MYW1iZGFGdW5jdGlvbihjb2xsZWN0b3JMYW1iZGEpKTtcblxuICAgIC8vIENyZWF0ZSBMYW1iZGEgZnVuY3Rpb24gZm9yIHByb2Nlc3NpbmcgdHJhZmZpYyBkYXRhIGZyb20gU1FTXG4gICAgY29uc3QgcHJvY2Vzc29yTGFtYmRhID0gbmV3IGxhbWJkYU5vZGVqcy5Ob2RlanNGdW5jdGlvbih0aGlzLCBgVHJhZmZpY1Byb2Nlc3NvckxhbWJkYS0ke2lkfWAsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yNF9YLFxuICAgICAgZW50cnk6IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi90cmFmZmljLXN0YXRzL2JhY2tlbmQvc3JjL2xhbWJkYXMvcHJvY2Vzc29yL2luZGV4LnRzJyksXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg2MCksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBEWU5BTU9EQl9UQUJMRV9OQU1FOiB0cmFmZmljRGF0YVRhYmxlLnRhYmxlTmFtZSxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzoge1xuICAgICAgICBleHRlcm5hbE1vZHVsZXM6IFsnYXdzLXNkayddLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIEFsbG93IHByb2Nlc3NvciBMYW1iZGEgdG8gd3JpdGUgdG8gRHluYW1vREJcbiAgICB0cmFmZmljRGF0YVRhYmxlLmdyYW50V3JpdGVEYXRhKHByb2Nlc3NvckxhbWJkYSk7XG5cbiAgICAvLyBHcmFudCBwZXJtaXNzaW9ucyB0byB0aGUgcHJvY2Vzc29yIExhbWJkYSB0byByZWNlaXZlIG1lc3NhZ2VzIGZyb20gU1FTXG4gICAgcHJvY2Vzc29yTGFtYmRhLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbJ3NxczpSZWNlaXZlTWVzc2FnZScsICdzcXM6RGVsZXRlTWVzc2FnZScsICdzcXM6R2V0UXVldWVBdHRyaWJ1dGVzJ10sXG4gICAgICByZXNvdXJjZXM6IFt0cmFmZmljRGF0YVF1ZXVlLnF1ZXVlQXJuXSxcbiAgICB9KSk7XG5cbiAgICAvLyBDb25maWd1cmUgU1FTIGFzIGV2ZW50IHNvdXJjZSBmb3IgcHJvY2Vzc29yIExhbWJkYVxuICAgIHByb2Nlc3NvckxhbWJkYS5hZGRFdmVudFNvdXJjZShuZXcgZXZlbnRTb3VyY2VzLlNxc0V2ZW50U291cmNlKHRyYWZmaWNEYXRhUXVldWUsIHtcbiAgICAgIGJhdGNoU2l6ZTogMTAsXG4gICAgfSkpO1xuXG4gICAgLy8gQ3JlYXRlIExhbWJkYSBmdW5jdGlvbnMgZm9yIEFQSSBlbmRwb2ludHNcbiAgICBjb25zdCBkYWlseURhdGFMYW1iZGEgPSBuZXcgbGFtYmRhTm9kZWpzLk5vZGVqc0Z1bmN0aW9uKHRoaXMsIGBEYWlseURhdGFMYW1iZGEtJHtpZH1gLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjRfWCxcbiAgICAgIGVudHJ5OiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vdHJhZmZpYy1zdGF0cy9iYWNrZW5kL3NyYy9sYW1iZGFzL2FwaS9kYWlseS1kYXRhL2luZGV4LnRzJyksXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBEWU5BTU9EQl9UQUJMRV9OQU1FOiB0cmFmZmljRGF0YVRhYmxlLnRhYmxlTmFtZSxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzoge1xuICAgICAgICBleHRlcm5hbE1vZHVsZXM6IFsnYXdzLXNkayddLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGhvdXJseUF2ZXJhZ2VMYW1iZGEgPSBuZXcgbGFtYmRhTm9kZWpzLk5vZGVqc0Z1bmN0aW9uKHRoaXMsIGBIb3VybHlBdmVyYWdlTGFtYmRhLSR7aWR9YCwge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzI0X1gsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL3RyYWZmaWMtc3RhdHMvYmFja2VuZC9zcmMvbGFtYmRhcy9hcGkvaG91cmx5LWF2ZXJhZ2UvaW5kZXgudHMnKSxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIERZTkFNT0RCX1RBQkxFX05BTUU6IHRyYWZmaWNEYXRhVGFibGUudGFibGVOYW1lLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7XG4gICAgICAgIGV4dGVybmFsTW9kdWxlczogWydhd3Mtc2RrJ10sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gR3JhbnQgcmVhZCBhY2Nlc3MgdG8gRHluYW1vREIgZm9yIEFQSSBMYW1iZGEgZnVuY3Rpb25zXG4gICAgdHJhZmZpY0RhdGFUYWJsZS5ncmFudFJlYWREYXRhKGRhaWx5RGF0YUxhbWJkYSk7XG4gICAgdHJhZmZpY0RhdGFUYWJsZS5ncmFudFJlYWREYXRhKGhvdXJseUF2ZXJhZ2VMYW1iZGEpO1xuXG4gICAgLy8gQ3JlYXRlIEFQSSBHYXRld2F5XG4gICAgY29uc3QgYXBpID0gbmV3IGFwaWdhdGV3YXkuUmVzdEFwaSh0aGlzLCBgVHJhZmZpY0RhdGFBcGktJHtpZH1gLCB7XG4gICAgICByZXN0QXBpTmFtZTogJ1RyYWZmaWMgRGF0YSBTZXJ2aWNlJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQVBJIGZvciB0cmFmZmljIHN0YXRpc3RpY3MgZGF0YScsXG4gICAgICBkZWZhdWx0Q29yc1ByZWZsaWdodE9wdGlvbnM6IHtcbiAgICAgICAgYWxsb3dPcmlnaW5zOiBhcGlnYXRld2F5LkNvcnMuQUxMX09SSUdJTlMsXG4gICAgICAgIGFsbG93TWV0aG9kczogYXBpZ2F0ZXdheS5Db3JzLkFMTF9NRVRIT0RTLFxuICAgICAgfSxcbiAgICAgIGRlcGxveU9wdGlvbnM6IHtcbiAgICAgICAgc3RhZ2VOYW1lOiAnYXBpJyxcbiAgICAgICAgdGhyb3R0bGluZ1JhdGVMaW1pdDogMTAwLCAvLyByZXF1ZXN0cyBwZXIgc2Vjb25kXG4gICAgICAgIHRocm90dGxpbmdCdXJzdExpbWl0OiAyMDAsIC8vIG1heGltdW0gY29uY3VycmVudCByZXF1ZXN0c1xuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIENyZWF0ZSBBUEkgcmVzb3VyY2VzIGFuZCBtZXRob2RzXG4gICAgY29uc3QgdHJhZmZpY1Jlc291cmNlID0gYXBpLnJvb3QuYWRkUmVzb3VyY2UoJ3RyYWZmaWMnKTtcbiAgICBjb25zdCBzdGF0aW9uUmVzb3VyY2UgPSB0cmFmZmljUmVzb3VyY2UuYWRkUmVzb3VyY2UoJ3N0YXRpb24nKTtcbiAgICBjb25zdCBzdGF0aW9uSWRSZXNvdXJjZSA9IHN0YXRpb25SZXNvdXJjZS5hZGRSZXNvdXJjZSgne3N0YXRpb25JZH0nKTtcblxuICAgIC8vIERhaWx5IGRhdGEgZW5kcG9pbnRcbiAgICBjb25zdCBkYWlseVJlc291cmNlID0gc3RhdGlvbklkUmVzb3VyY2UuYWRkUmVzb3VyY2UoJ2RhaWx5Jyk7XG4gICAgZGFpbHlSZXNvdXJjZS5hZGRNZXRob2QoJ0dFVCcsIG5ldyBhcGlnYXRld2F5LkxhbWJkYUludGVncmF0aW9uKGRhaWx5RGF0YUxhbWJkYSkpO1xuXG4gICAgLy8gSG91cmx5IGF2ZXJhZ2UgZW5kcG9pbnRcbiAgICBjb25zdCBob3VybHlBdmVyYWdlUmVzb3VyY2UgPSBzdGF0aW9uSWRSZXNvdXJjZS5hZGRSZXNvdXJjZSgnaG91cmx5LWF2ZXJhZ2UnKTtcbiAgICBob3VybHlBdmVyYWdlUmVzb3VyY2UuYWRkTWV0aG9kKCdHRVQnLCBuZXcgYXBpZ2F0ZXdheS5MYW1iZGFJbnRlZ3JhdGlvbihob3VybHlBdmVyYWdlTGFtYmRhKSk7XG5cbiAgICAvLyBFeHBvcnQgdGhlIEFQSSBVUkwgZm9yIHRoZSBmcm9udGVuZFxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIGBBcGlVcmwtJHtpZH1gLCB7XG4gICAgICB2YWx1ZTogYXBpLnVybCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnVGhlIFVSTCBvZiB0aGUgQVBJIEdhdGV3YXknLFxuICAgIH0pO1xuXG4gICAgLy8gQ3JlYXRlIFMzIGJ1Y2tldCBmb3IgZnJvbnRlbmRcbiAgICBjb25zdCBmcm9udGVuZEJ1Y2tldCA9IG5ldyBzMy5CdWNrZXQodGhpcywgYEZyb250ZW5kQnVja2V0LSR7aWR9YCwge1xuICAgICAgd2Vic2l0ZUluZGV4RG9jdW1lbnQ6ICdpbmRleC5odG1sJyxcbiAgICAgIHB1YmxpY1JlYWRBY2Nlc3M6IHRydWUsXG4gICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUNMUyxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICBhdXRvRGVsZXRlT2JqZWN0czogdHJ1ZVxuICAgIH0pO1xuXG4gICAgLy8gQ3JlYXRlIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uIGZvciBmcm9udGVuZFxuICAgIGNvbnN0IGRpc3RyaWJ1dGlvbiA9IG5ldyBjbG91ZGZyb250LkRpc3RyaWJ1dGlvbih0aGlzLCBgRnJvbnRlbmREaXN0cmlidXRpb24tJHtpZH1gLCB7XG4gICAgICBkZWZhdWx0QmVoYXZpb3I6IHsgb3JpZ2luOiBuZXcgb3JpZ2lucy5TM09yaWdpbihmcm9udGVuZEJ1Y2tldCkgfSxcbiAgICB9KTtcblxuICAgIC8vIERlcGxveSBmcm9udGVuZCB0byBTMyBidWNrZXRcbiAgICBuZXcgczNkZXBsb3kuQnVja2V0RGVwbG95bWVudCh0aGlzLCBgRGVwbG95RnJvbnRlbmQtJHtpZH1gLCB7XG4gICAgICBzb3VyY2VzOiBbczNkZXBsb3kuU291cmNlLmFzc2V0KHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi90cmFmZmljLXN0YXRzL2Zyb250ZW5kL2Rpc3QnKSldLFxuICAgICAgZGVzdGluYXRpb25CdWNrZXQ6IGZyb250ZW5kQnVja2V0LFxuICAgICAgY2FjaGVDb250cm9sOiBbczNkZXBsb3kuQ2FjaGVDb250cm9sLm1heEFnZShjZGsuRHVyYXRpb24uc2Vjb25kcygwKSldLFxuICAgICAgZGlzdHJpYnV0aW9uOiBkaXN0cmlidXRpb24sXG4gICAgfSk7XG5cbiAgICAvKlxuICAgICAgICAvLyBDcmVhdGUgYSB0ZW1wb3JhcnkgZGlyZWN0b3J5IGZvciB0aGUgY29uZmlnIGZpbGVcbiAgICAgICAgY29uc3QgdGVtcERpciA9IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi90cmFmZmljLXN0YXRzL2Zyb250ZW5kL3RlbXAnKTtcbiAgICAgICAgaWYgKCFmcy5leGlzdHNTeW5jKHRlbXBEaXIpKSB7XG4gICAgICAgICAgZnMubWtkaXJTeW5jKHRlbXBEaXIpO1xuICAgICAgICB9XG4gICAgXG4gICAgICAgIC8vIFJlYWQgdGhlIHRlbXBsYXRlIGZpbGVcbiAgICAgICAgY29uc3QgY29uZmlnVGVtcGxhdGUgPSBmcy5yZWFkRmlsZVN5bmMocGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL3RyYWZmaWMtc3RhdHMvZnJvbnRlbmQvc3JjL2NvbmZpZy50ZW1wbGF0ZScpLCAndXRmOCcpO1xuICAgIFxuICAgICAgICAvLyBSZXBsYWNlIHRoZSBwbGFjZWhvbGRlciB3aXRoIHRoZSBhY3R1YWwgQVBJIFVSTFxuICAgICAgICBjb25zdCBjb25maWdDb250ZW50ID0gY29uZmlnVGVtcGxhdGUucmVwbGFjZSgnX19BUElfVVJMX18nLCBgaHR0cHM6Ly8ke2FwaS5yZXN0QXBpSWR9LmV4ZWN1dGUtYXBpLiR7Y2RrLkF3cy5SRUdJT059LiR7Y2RrLkF3cy5VUkxfU1VGRklYfS8ke2FwaS5kZXBsb3ltZW50U3RhZ2Uuc3RhZ2VOYW1lfS9gKTtcbiAgICBcbiAgICAgICAgLy8gV3JpdGUgdGhlIHVwZGF0ZWQgY29udGVudCB0byB0aGUgdGVtcG9yYXJ5IGRpcmVjdG9yeVxuICAgICAgICBjb25zdCB0ZW1wQ29uZmlnUGF0aCA9IHBhdGguam9pbih0ZW1wRGlyLCAnY29uZmlnLnRzJyk7XG4gICAgICAgIGZzLndyaXRlRmlsZVN5bmModGVtcENvbmZpZ1BhdGgsIGNvbmZpZ0NvbnRlbnQpO1xuICAgIFxuICAgICAgICAvLyBQYXNzIEFQSSBVUkwgdG8gZnJvbnRlbmRcbiAgICAgICAgbmV3IHMzZGVwbG95LkJ1Y2tldERlcGxveW1lbnQodGhpcywgYERlcGxveUZyb250ZW5kQ29uZmlnLSR7aWR9YCwge1xuICAgICAgICAgIHNvdXJjZXM6IFtzM2RlcGxveS5Tb3VyY2UuYXNzZXQodGVtcERpcildLFxuICAgICAgICAgIGRlc3RpbmF0aW9uQnVja2V0OiBmcm9udGVuZEJ1Y2tldCxcbiAgICAgICAgICBkZXN0aW5hdGlvbktleVByZWZpeDogJ3NyYycsXG4gICAgICAgICAgY2FjaGVDb250cm9sOiBbczNkZXBsb3kuQ2FjaGVDb250cm9sLm5vQ2FjaGUoKV0sXG4gICAgICAgIH0pO1xuICAgICovXG4gICAgLy8gT3V0cHV0IHRoZSBDbG91ZEZyb250IFVSTFxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIGBGcm9udGVuZFVybC0ke2lkfWAsIHtcbiAgICAgIHZhbHVlOiBkaXN0cmlidXRpb24uZGlzdHJpYnV0aW9uRG9tYWluTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnVGhlIFVSTCBvZiB0aGUgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24gZm9yIHRoZSBmcm9udGVuZCcsXG4gICAgfSk7XG4gIH1cbn1cbiJdfQ==