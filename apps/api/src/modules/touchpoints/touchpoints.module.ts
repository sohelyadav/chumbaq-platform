import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TouchpointEntity } from './entities/touchpoint.entity';
import { TouchpointsService } from './touchpoints.service';
import { TouchpointsController } from './touchpoints.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([TouchpointEntity]),
  ],
  controllers: [TouchpointsController],
  providers: [TouchpointsService],
  exports: [TouchpointsService],
})
export class TouchpointsModule {}
