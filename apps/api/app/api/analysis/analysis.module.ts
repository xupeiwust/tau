import { Module } from '@nestjs/common';
import { AnalysisController } from '#api/analysis/analysis.controller.js';
import { AnalysisService } from '#api/analysis/analysis.service.js';
import { GeometryAnalysisService } from '#api/analysis/geometry-analysis.service.js';

@Module({
  controllers: [AnalysisController],
  providers: [AnalysisService, GeometryAnalysisService],
  exports: [AnalysisService, GeometryAnalysisService],
})
export class AnalysisModule {}
