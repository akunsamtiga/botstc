import { Module } from '@nestjs/common';
import { FastradeController } from './fastrade.controller';
import { FastradeService } from './fastrade.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [FastradeController],
  providers: [FastradeService],
})
export class FastradeModule {}