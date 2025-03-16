# traffic-stations
Digitraffic LAM data collector in AWS cloud and frotend to show data

Project is imlemented using VS Code Copilot.

All components are deployed using AWS CDK.

**Backend**

Backend is implemented as cloud-based.

There is two lambda functions ans SQS queue to collect data into DynamoDB database.

REST endpoints to fetch dynamodb data are also implemented as lambda functios. There is API gateway to serve REST endpoints.

Collector lambda collects data fro Digitraffic endpoint once a hours and sends data to the SQS queue.

Processor lambda reads SQS queue and stores data into DynamoDB database table.

API endpoints read data from the dd, calculates endpoint data and returns data.

Digitraffic <-- collector --> SQS --> processor --> DynamoDB table

**Frontend**

Frontend is imlemented as React and project tool is Vite.

You can run frontend locally using commands

```
cd traffic-stats
npm install
npm run dev
```
Local dev uses cloud backend.

**Deployment**

Deployment is done using AWS CDK.

Backdend and frontend are both deployed to the AWS cloud.

See deployent results to get backend and frontend urls.

First ensure that you have AWS CLI configured and rights to deploy.

```
cdk synth
cd deploy
```

