# traffic-stations
Digitraffic LAM data collector in AWS cloud and frontend to show data.

Project is implemented using VS Code Copilot.

All components are deployed using AWS CDK.

**Backend**

Backend is implemented as cloud-based.

There are two lambda functions and SQS queue to collect data into DynamoDB database.

REST endpoints to fetch data from Dynamodb are also implemented as lambda functions. There is API gateway to serve REST endpoints.

Collector lambda collects data from Digitraffic endpoint once per hour and sends data to the SQS queue.

Processor lambda reads SQS queue and stores data into DynamoDB database table.

API endpoints read data from the db, calculate endpoint data and return data.

Digitraffic <-- collector --> SQS --> processor --> DynamoDB table

**Frontend**

Frontend is implemented using React and project tool is Vite.

You can run frontend locally using commands

```
cd traffic-stats
npm install
npm run dev
```
Local dev uses cloud backend.

**Deployment**

Deployment is done using AWS CDK.

Backend and frontend are both deployed to the AWS cloud.

See deployment results to get backend and frontend urls.

First ensure that you have AWS CLI configured and rights to deploy.

```
cdk synth
cd deploy
```

