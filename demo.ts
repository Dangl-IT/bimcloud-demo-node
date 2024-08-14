import * as fs from "fs";

import { Readable } from "stream";
import { Server } from "http";
import express from "express";
import { getOAuth2AccessToken } from "./utils";
import net from "net";
import path from "path";

type AssetResponse = {
  uploadLink: string;
  finishFileUploadLink: string;
  cancelFileUploadLink: string;
  assetId: string;
};

type BimCloudAsset = {
  id: string;
  operations: BimCloudOperation[];
};

type BimCloudOperation = {
  id: string;
  type: string;
  status: "Pending" | "Started" | "Finished" | "Failed" | "Canceled";
};

// Please provide your client id and client secret for this demo
const clientId = "";
const clientSecret = "";
const identityTokenUrl = "https://identity-dev.dangl-it.com/connect/token";
const bimcloudBaseUrl = "https://bimcloud-dev.dangl-it.com";
const sourceBimFilePath = "IfcDuplexHouse.ifc";

let accessToken: string;

async function launchDemo(): Promise<void> {
  if (!clientId || !clientSecret) {
    throw new Error(
      "Please provide your client id and client secret for this demo"
    );
  }

  // First we're getting a token
  accessToken = await getOAuth2AccessToken(
    clientId,
    clientSecret,
    identityTokenUrl
  );

  // Then we're creating an asset
  const assetResponse = await createAsset();

  // Then we upload the source IFC file
  await uploadIfcFile(assetResponse);

  // And announce that we've finished the file upload
  await announceFileUploadFinished(assetResponse);

  // Then we get the operations
  const assetData = await getBimCloudAssetData(assetResponse.assetId);

  // We'll wait until each operation is finished simultaneously
  // and download the results
  let geometryFileName;
  let structureFileName;
  await Promise.all(
    assetData.operations.map(async (operation) => {
      const fileName = await waitUntilOperationFinishedAndDownloadAsset(
        assetResponse.assetId,
        operation
      );

      if (operation.type === "WexbimGeometryConversion") {
        geometryFileName = fileName;
      } else if (operation.type === "StructureConversion") {
        structureFileName = fileName;
      }
    })
  );

  // Then we'll launch a small web server that shows a viewer
  await launchServer(geometryFileName || "", structureFileName || "");
}

async function createAsset(): Promise<AssetResponse> {
  // We're sending an object like this:
  // {
  //   "fileName": "string"
  //   "sizeInBytes": 0
  // }
  // to https://bimcloud-dev.dangl-it.com/api/assets
  // and we're taking the information from the file 'IfcDuplexHouse.ifc'

  // In the result, BIMCloud will create an asset for us and will wait
  // until we've uploaded the file to the storage. After we've done that,
  // BIMCloud will be able to start processing the model.

  var fileInfo = fs.statSync(sourceBimFilePath);
  const assetResponse = await fetch(bimcloudBaseUrl + "/api/assets", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fileName: sourceBimFilePath,
      // We're announcing the file size in advance to BIMCloud
      sizeInBytes: fileInfo.size,
    }),
  });

  const assetResponseJson = await assetResponse.json();
  return assetResponseJson;
}

async function uploadIfcFile(assetResponse: AssetResponse): Promise<void> {
  // We're using the 'uploadLink' property from the assetResponse
  // to upload the file 'IfcDuplexHouse.ifc' to an Azure blob storage container
  // Unfortunately, we need to specify the header 'x-ms-blob-type' with the value 'BlockBlob'
  // since that's requireds by Azure, see https://stackoverflow.com/questions/37824136/put-on-sas-blob-url-without-specifying-x-ms-blob-type-header
  const fileInfo = fs.statSync(sourceBimFilePath);
  const fileBuffer = fs.readFileSync(sourceBimFilePath);
  const blob = new Blob([fileBuffer]);
  const response = await fetch(assetResponse.uploadLink, {
    method: "PUT",
    body: blob,
    headers: {
      "Content-Length": fileInfo.size.toString(),
      "x-ms-blob-type": "BlockBlob",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to upload file: ${response.statusText}`);
  }

  console.log("File uploaded successfully");
}

async function announceFileUploadFinished(
  assetResponse: AssetResponse
): Promise<void> {
  // We're sending a PUT request to the 'finishFileUploadLink' property
  // of the assetResponse
  await fetch(assetResponse.finishFileUploadLink, {
    method: "PUT",
    headers: {
      Authorization: "Bearer " + accessToken,
    },
  });
}

async function getBimCloudAssetData(assetId: string): Promise<BimCloudAsset> {
  const response = await fetch(bimcloudBaseUrl + "/api/assets/" + assetId, {
    method: "GET",
    headers: {
      Authorization: "Bearer " + accessToken,
    },
  });
  return await response.json();
}

async function waitUntilOperationFinishedAndDownloadAsset(
  assetId: string,
  operation: BimCloudOperation
): Promise<string> {
  // We're sending a GET request to https://bimcloud-dev.dangl-it.com/api/assets/{assetId}/operations/{operationId}
  // and checking the 'status' property
  // If it's 'Finished', we're sending a GET request to the 'downloadLink' property
  // and downloading the file
  // If it's 'Failed', we're logging an error to the console
  // We're also waiting for a few seconds between each poll

  let latestStatus = operation.status;
  let hasFinished = false;
  console.log(
    "Initial status for operation type " +
      operation.type +
      " is " +
      operation.status
  );

  let fileName;
  while (!hasFinished) {
    const response = await fetch(
      bimcloudBaseUrl +
        "/api/assets/" +
        assetId +
        "/operations/" +
        operation.id,
      {
        method: "GET",
        headers: {
          Authorization: "Bearer " + accessToken,
        },
      }
    );

    const operationData = (await response.json()) as BimCloudOperation;

    // If the status has changed, we're logging to the console
    if (latestStatus !== operationData.status) {
      console.log(
        "Operation status changed to " +
          operationData.status +
          " for operation type " +
          operationData.type
      );
      latestStatus = operationData.status;
    }

    // If the operation is finished, we're downloading the asset
    if (operationData.status === "Finished") {
      hasFinished = true;
      console.log(
        "Operation finished for type " + operation.type + " , downloading asset"
      );

      const downloadInstructionsResponse = await fetch(
        bimcloudBaseUrl +
          "/api/assets/" +
          assetId +
          "/operations/" +
          operation.id +
          "/content",
        {
          method: "GET",
          headers: {
            Authorization: "Bearer " + accessToken,
          },
        }
      );
      const downloadLink = (await downloadInstructionsResponse.json())
        .downloadLink;

      // We're downloading the asset
      // This is a simple GET request to the 'downloadLink' property
      // of the operation response
      // We're saving the file to the current directory
      const downloadResponse = await fetch(downloadLink);

      fileName = downloadResponse.headers
        .get("Content-Disposition")
        ?.split(";")
        .find((part) => part.includes("filename="))
        ?.split("=")[1]
        .replace(/"/g, "");

      if (downloadResponse.ok && downloadResponse.body) {
        const streamWriter = fs.createWriteStream(
          fileName || "downloadedAsset_" + operation.type
        );
        Readable.fromWeb(downloadResponse.body as any).pipe(streamWriter);
      }
    } else if (operationData.status === "Failed") {
      hasFinished = true;
      console.log("Operation failed for type " + operation.type);
    } else {
      // If the operation is still pending, we're waiting for a few seconds
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  return fileName || "";
}

async function launchServer(
  geometryFileName: string,
  structureFileName: string
): Promise<void> {
  const app = express();
  const port = await getEmptyPort();
  let server: Server;

  // Serve the static HTML file
  app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "demo.html"));
  });

  app.get("/dependencies.js", (req, res) => {
    res.sendFile(path.join(__dirname, "node_modules/@xbim/viewer/index.js"));
  });

  app.get("/model.wexbim", (req, res) => {
    res.sendFile(path.join(__dirname, geometryFileName));
  });

  app.get("/model.json", (req, res) => {
    res.sendFile(path.join(__dirname, structureFileName));
  });

  // Route to close the server
  app.post("/stop-server", (req, res) => {
    res.send("Server is closing...");
    server.close(() => {
      console.log("Server closed");
    });
  });

  // Start the server
  server = app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
  });

  // Return a promise that resolves when the server is closed
  return new Promise<void>((resolve) => {
    server.on("close", () => {
      resolve();
    });
  });
}

async function getEmptyPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(port);
        }
      });
    });
    server.on("error", (err) => {
      reject(err);
    });
  });
}

launchDemo();
