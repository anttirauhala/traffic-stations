# traffic-stations
Digitraffic LAM data collector in AWS cloud and frontend to show data.

Project is implemented using VS Code Copilot.

All components are deployed using AWS CDK.

## Prerequisites

Node.js **24.22.1 or newer** is required (pinned in `.nvmrc` and `engines` in the package.json files).
24.22.1 is the first Node.js 24 release patched for the Brotli decoder remote code execution
vulnerability CVE-2026-111497 ("Node2Shell"), so older Node.js versions must not be used.

```
nvm use
```

The Lambda functions are deployed with the `NODEJS_24_X` runtime.

AWS patches the managed `nodejs24.x` runtime on its own schedule, so the runtime version identifier
alone does not tell which Node.js patch level is in use. The collector Lambda logs
`NODE_VERSION <version>` on every hourly run, so the actual Node.js version can be verified from
CloudWatch Logs (this is the method AWS documents for Node.js runtimes):

```
npm run check:runtime
```

The script exits with `0` when the deployed runtime is at least the version required for
CVE-2026-111497 and with `1` when it is not yet patched. AWS updates the managed runtime in place,
so no redeploy is needed - only the check needs to be repeated.

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

The Lambda functions are bundled with esbuild. Either have Docker available, or install esbuild
as a dev dependency (`npm install --save-dev esbuild`) to bundle locally without Docker.

```
cdk synth
cd deploy
```

