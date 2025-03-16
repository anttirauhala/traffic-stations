import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import * as eventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as fs from 'fs';

const DEVELOPMENT_ENV = false;

export class TrafficStatsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
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
      runtime: lambda.Runtime.NODEJS_18_X,
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
      runtime: lambda.Runtime.NODEJS_18_X,
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
      runtime: lambda.Runtime.NODEJS_18_X,
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
      runtime: lambda.Runtime.NODEJS_18_X,
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
      removalPolicy: DEVELOPMENT_ENV ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
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
