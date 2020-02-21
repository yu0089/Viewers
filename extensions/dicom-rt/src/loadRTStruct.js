import OHIF from '@ohif/core';
import * as dcmjs from 'dcmjs';
import cornerstone from 'cornerstone-core';
import cornerstoneTools from 'cornerstone-tools';
import transformPointsToImagePlane from './utils/transformPointsToImagePlane';
import TOOL_NAMES from './utils/toolNames';

const dicomlab2RGB = dcmjs.data.Colors.dicomlab2RGB;
const globalImageIdSpecificToolStateManager =
  cornerstoneTools.globalImageIdSpecificToolStateManager;
const { DicomLoaderService } = OHIF.utils;

export default async function loadRTStruct(
  rtStructDisplaySet,
  referencedDisplaySet,
  studies
) {
  const rtStructModule = cornerstoneTools.getModule('rtstruct');

  // Set here is loading is asynchronous.
  // If this function throws its set back to false.
  rtStructDisplaySet.isLoaded = true;

  const { studyInstanceUid, seriesInstanceUid } = referencedDisplaySet;

  const segArrayBuffer = await DicomLoaderService.findDicomDataPromise(
    rtStructDisplaySet,
    studies
  );

  const dicomData = dcmjs.data.DicomMessage.readFile(segArrayBuffer);
  const rtStructDataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(
    dicomData.dict
  );

  rtStructDataset._meta = dcmjs.data.DicomMetaDictionary.namifyDataset(
    dicomData.meta
  );

  // global cornerstone tools state to attach measurements to.
  const toolState = globalImageIdSpecificToolStateManager.saveToolState();

  debugger;

  const {
    StructureSetROISequence,
    ROIContourSequence,
    RTROIObservationsSequence,
    StructureSetLabel,
  } = rtStructDataset;

  // Define our structure set entry and add it to the rtstruct module state.
  const structureSet = {
    structureSetLabel: StructureSetLabel,
    seriesInstanceUid: rtStructDataset.SeriesInstanceUID,
    ROIContours: [],
    referencedSeriesSequence: rtStructDisplaySet.referencedSeriesSequence,
    visible: true,
  };

  console.log(structureSet);

  rtStructModule.setters.structureSet(structureSet);

  const imageIdSopInstanceUidPairs = _getImageIdSopInstanceUidPairsForDisplaySet(
    studies,
    studyInstanceUid,
    seriesInstanceUid
  );

  debugger;

  const rtStructDisplayToolName = TOOL_NAMES.RTSTRUCT_DISPLAY_TOOL;

  for (let i = 0; i < ROIContourSequence.length; i++) {
    const ROIContour = ROIContourSequence[i];
    const { ReferencedROINumber, ContourSequence } = ROIContour;

    _setROIContourMetadata(
      structureSet,
      StructureSetROISequence,
      RTROIObservationsSequence,
      ROIContour
    );

    for (let c = 0; c < ContourSequence.length; c++) {
      const {
        ContourImageSequence,
        ContourData,
        NumberOfContourPoints,
        ContourGeometricType,
      } = ContourSequence[c];

      if (ContourGeometricType !== 'CLOSED_PLANAR') {
        // TODO: Do we want to visualise types other than closed planar?
        // We could easily do open planar.
        continue;
      }

      const sopInstanceUID = ContourImageSequence.ReferencedSOPInstanceUID;
      const imageId = _getImageId(imageIdSopInstanceUidPairs, sopInstanceUID);
      const imageIdSpecificToolData = _getOrCreateImageIdSpecificToolData(
        toolState,
        imageId,
        rtStructDisplayToolName
      );

      const imagePlane = cornerstone.metaData.get('imagePlaneModule', imageId);
      const points = [];

      for (let p = 0; p < NumberOfContourPoints * 3; p += 3) {
        points.push({
          x: ContourData[p],
          y: ContourData[p + 1],
          z: ContourData[p + 2],
        });
      }

      transformPointsToImagePlane(points, imagePlane);

      const measurementData = {
        handles: {
          points,
        },
        structureSetSeriesInstanceUid: rtStructDataset.SeriesInstanceUID,
        ROINumber: ReferencedROINumber,
      };

      imageIdSpecificToolData.push(measurementData);
    }
  }

  _setToolEnabledIfNotEnabled(rtStructDisplayToolName);
}

function _setROIContourMetadata(
  structureSet,
  StructureSetROISequence,
  RTROIObservationsSequence,
  ROIContour
) {
  const StructureSetROI = StructureSetROISequence.find(
    structureSetROI =>
      structureSetROI.ROINumber === ROIContour.ReferencedROINumber
  );

  const ROIContourData = {
    ROINumber: StructureSetROI.ROINumber,
    ROIName: StructureSetROI.ROIName,
    ROIGenerationAlgorithm: StructureSetROI.ROIGenerationAlgorithm,
    ROIDescription: StructureSetROI.ROIDescription,
    visible: true,
  };

  _setROIContourDataColor(ROIContour, ROIContourData);

  if (RTROIObservationsSequence) {
    // If present, add additional RTROIObservations metadata.
    _setROIContourRTROIObservations(
      ROIContourData,
      RTROIObservationsSequence,
      ROIContour.ReferencedROINumber
    );
  }

  structureSet.ROIContours.push(ROIContourData);
}

function _setROIContourDataColor(ROIContour, ROIContourData) {
  let { ROIDisplayColor, RecommendedDisplayCIELabValue } = ROIContour;

  if (!ROIDisplayColor && RecommendedDisplayCIELabValue) {
    // If ROIDisplayColor is absent, try using the RecommendedDisplayCIELabValue color.
    ROIDisplayColor = dicomlab2RGB(RecommendedDisplayCIELabValue);
  }

  if (ROIDisplayColor) {
    ROIContourData.ROIDisplayColor = `rgb(${ROIDisplayColor[0]},${
      ROIDisplayColor[1]
    },${ROIDisplayColor[2]})`;
  } else {
    //Choose a color from the cornerstoneTools colorLUT
    // We sample from the default color LUT here (i.e. 0), as we have nothing else to go on.
    const { getters } = cornerstoneTools.getModule('segmentation');
    const color = getters.colorForSegmentIndexColorLUT(
      0,
      ROIContourData.ROINumber
    );

    ROIContourData.ROIDisplayColor = `rgb(${color[0]},${color[1]},${color[2]})`;
  }
}

function _setROIContourRTROIObservations(
  ROIContourData,
  RTROIObservationsSequence,
  ROINumber
) {
  const RTROIObservations = RTROIObservationsSequence.find(
    RTROIObservations => RTROIObservations.ReferencedROINumber === ROINumber
  );

  if (RTROIObservations) {
    // Deep copy so we don't keep the reference to the dcmjs dataset entry.
    const {
      ObservationNumber,
      ROIObservationDescription,
      RTROIInterpretedType,
      ROIInterpreter,
    } = RTROIObservations;

    ROIContourData.RTROIObservations = {
      ObservationNumber,
      ROIObservationDescription,
      RTROIInterpretedType,
      ROIInterpreter,
    };
  }
}

function _setToolEnabledIfNotEnabled(toolName) {
  cornerstone.getEnabledElements().forEach(enabledElement => {
    const { element } = enabledElement;
    const tool = cornerstoneTools.getToolForElement(element, toolName);

    if (tool.mode !== 'enabled') {
      // If not already active or passive, set passive so contours render.
      cornerstoneTools.setToolEnabled(toolName);
    }

    cornerstone.updateImage(element);
  });
}

function _getOrCreateImageIdSpecificToolData(toolState, imageId, toolName) {
  if (toolState.hasOwnProperty(imageId) === false) {
    toolState[imageId] = {};
  }

  const imageIdToolState = toolState[imageId];

  // If we don't have tool state for this type of tool, add an empty object
  if (imageIdToolState.hasOwnProperty(toolName) === false) {
    imageIdToolState[toolName] = {
      data: [],
    };
  }

  return imageIdToolState[toolName].data;
}

const _getImageId = (imageIdSopInstanceUidPairs, sopInstanceUID) => {
  const imageIdSopInstanceUidPairsEntry = imageIdSopInstanceUidPairs.find(
    imageIdSopInstanceUidPairsEntry =>
      imageIdSopInstanceUidPairsEntry.sopInstanceUID === sopInstanceUID
  );

  return imageIdSopInstanceUidPairsEntry.imageId;
};

function _getImageIdSopInstanceUidPairsForDisplaySet(
  studies,
  studyInstanceUid,
  seriesInstanceUid
) {
  const study = studies.find(
    study => study.studyInstanceUid === studyInstanceUid
  );

  const displaySets = study.displaySets.filter(set => {
    return set.seriesInstanceUid === seriesInstanceUid;
  });

  if (displaySets.length > 1) {
    console.warn(
      'More than one display set with the same seriesInstanceUid. This is not supported yet...'
    );
    // TODO -> We could make check the instance list and see if any match?
    // Do we split the segmentation into two cornerstoneTools segmentations if there are images in both series?
    // ^ Will that even happen?
  }

  const referencedDisplaySet = displaySets[0];

  return referencedDisplaySet.images.map(image => {
    return {
      imageId: image.getImageId(),
      sopInstanceUID: image.getSOPInstanceUID(),
    };
  });
}
